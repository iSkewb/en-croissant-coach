//! Tauri commands for the Coach (see `crate::training` for the logic).

use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

use log::warn;
use tauri::Manager;

use crate::{
    error::Error,
    progress::update_progress,
    training::{
        coach, ingest, store::Store, CoachSettings, CoachSettingsView, DrillCard, IngestOptions,
        IngestSummary, Insight, Mistake, MistakeFilter, TrainingError, TrainingStats,
    },
    AppState,
};

pub const INGEST_PROGRESS_ID: &str = "training_ingest";

impl From<TrainingError> for Error {
    fn from(e: TrainingError) -> Self {
        Error::Training(e.to_string())
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    Ok(app.path().app_data_dir()?)
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    Ok(data_dir(app)?.join("training.db"))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    Ok(data_dir(app)?.join("coach.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Result<CoachSettings, Error> {
    let p = settings_path(app)?;
    let mut s: CoachSettings = match std::fs::read_to_string(&p) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_default(),
        Err(_) => CoachSettings::default(),
    };
    // An environment variable wins, so the key never has to be stored on disk.
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if !k.is_empty() {
            s.api_key = Some(k);
        }
    }
    Ok(s)
}

fn save_settings(app: &tauri::AppHandle, s: &CoachSettings) -> Result<(), Error> {
    let p = settings_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(s).map_err(|e| Error::Training(e.to_string()))?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn require_key(s: &CoachSettings) -> Result<String, Error> {
    s.api_key
        .clone()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| Error::Training("Add your Anthropic API key in Coach → Settings first.".into()))
}

/// Analyse new games from a downloaded PGN file. Cancel with `cancel_analysis("training_ingest")`.
#[tauri::command]
#[specta::specta]
pub async fn training_ingest(
    pgn_path: PathBuf,
    options: IngestOptions,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<IngestSummary, Error> {
    let db = db_path(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .analysis_cancel_flags
        .insert(INGEST_PROGRESS_ID.to_string(), cancel.clone());

    let progress_app = app.clone();
    let result = ingest::ingest_file(&pgn_path, &db, &options, cancel, move |p| {
        let st = progress_app.state::<AppState>();
        let _ = update_progress(
            &st.progress_state,
            &progress_app,
            INGEST_PROGRESS_ID.to_string(),
            p,
            false,
        );
    })
    .await;
    state.analysis_cancel_flags.remove(INGEST_PROGRESS_ID);
    update_progress(
        &state.progress_state,
        &app,
        INGEST_PROGRESS_ID.to_string(),
        100.0,
        true,
    )?;
    let mut summary = result?;

    // Seamless personalisation: refresh the pattern analysis once enough new mistakes piled up.
    let settings = load_settings(&app)?;
    if settings.auto_insight_every > 0 && !summary.cancelled {
        if let Ok(key) = require_key(&settings) {
            let since_last = {
                let store = Store::open(&db)?;
                let now = store.serious_mistake_count()?;
                let at_last = store.latest_insight()?.map(|i| i.mistakes_analyzed).unwrap_or(0);
                now.saturating_sub(at_last)
            };
            if since_last >= settings.auto_insight_every {
                match coach::analyze_patterns(&key, &settings.model, &db).await {
                    Ok(_) => summary.insight_refreshed = true,
                    Err(e) => warn!("automatic coach insight failed: {e}"),
                }
            }
        }
    }
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn training_stats(app: tauri::AppHandle) -> Result<TrainingStats, Error> {
    Ok(Store::open(&db_path(&app)?)?.stats()?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_mistakes(
    filter: MistakeFilter,
    app: tauri::AppHandle,
) -> Result<Vec<Mistake>, Error> {
    Ok(Store::open(&db_path(&app)?)?.list_mistakes(&filter)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_mistake(id: i64, app: tauri::AppHandle) -> Result<Option<Mistake>, Error> {
    Ok(Store::open(&db_path(&app)?)?.get_mistake(id)?)
}

/// Due drill cards first, then up to `new_limit` new ones. Cards matching the coach's
/// current weaknesses come first.
#[tauri::command]
#[specta::specta]
pub async fn training_drill_queue(
    limit: u32,
    new_limit: u32,
    app: tauri::AppHandle,
) -> Result<Vec<DrillCard>, Error> {
    let store = Store::open(&db_path(&app)?)?;
    let focus = store.focus_tags()?;
    Ok(store.drill_queue(&focus, limit, new_limit)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_save_card(
    mistake_id: i64,
    card_json: String,
    due_iso: String,
    lapse: bool,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    Ok(Store::open(&db_path(&app)?)?.save_card(mistake_id, &card_json, &due_iso, lapse)?)
}

/// Engine-verified facts about a mistake. Works offline, no AI needed.
#[tauri::command]
#[specta::specta]
pub async fn training_facts(mistake_id: i64, app: tauri::AppHandle) -> Result<Vec<String>, Error> {
    let store = Store::open(&db_path(&app)?)?;
    let m = store
        .get_mistake(mistake_id)?
        .ok_or_else(|| Error::Training("mistake not found".into()))?;
    let (best, refut) = store.get_mistake_lines(mistake_id)?;
    Ok(crate::training::features::explain_facts(
        &m.fen_before,
        &m.played_uci,
        &best,
        &refut,
    ))
}

/// AI explanation of one mistake (cached unless `refresh`).
#[tauri::command]
#[specta::specta]
pub async fn training_explain(
    mistake_id: i64,
    refresh: bool,
    app: tauri::AppHandle,
) -> Result<String, Error> {
    let db = db_path(&app)?;
    if !refresh {
        if let Some(t) = Store::open(&db)?.get_explanation(mistake_id)? {
            return Ok(t);
        }
    }
    let s = load_settings(&app)?;
    let key = require_key(&s)?;
    Ok(coach::explain_mistake(&key, &s.model, &db, mistake_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_run_insights(app: tauri::AppHandle) -> Result<Option<Insight>, Error> {
    let db = db_path(&app)?;
    let s = load_settings(&app)?;
    let key = require_key(&s)?;
    coach::analyze_patterns(&key, &s.model, &db).await?;
    Ok(Store::open(&db)?.latest_insight()?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_latest_insight(app: tauri::AppHandle) -> Result<Option<Insight>, Error> {
    Ok(Store::open(&db_path(&app)?)?.latest_insight()?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_get_settings(app: tauri::AppHandle) -> Result<CoachSettingsView, Error> {
    let s = load_settings(&app)?;
    Ok(CoachSettingsView {
        has_api_key: s.api_key.map(|k| !k.is_empty()).unwrap_or(false),
        model: s.model,
        auto_insight_every: s.auto_insight_every,
    })
}

/// `api_key`: `None` keeps the current key, `Some("")` removes it.
#[tauri::command]
#[specta::specta]
pub async fn training_set_settings(
    api_key: Option<String>,
    model: String,
    auto_insight_every: u32,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    let p = settings_path(&app)?;
    let mut s: CoachSettings = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Some(k) = api_key {
        s.api_key = if k.trim().is_empty() { None } else { Some(k.trim().to_string()) };
    }
    s.model = model;
    s.auto_insight_every = auto_insight_every;
    save_settings(&app, &s)
}

#[tauri::command]
#[specta::specta]
pub async fn training_tag_glossary() -> Result<Vec<(String, String)>, Error> {
    Ok(coach::TAG_GLOSSARY
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect())
}
