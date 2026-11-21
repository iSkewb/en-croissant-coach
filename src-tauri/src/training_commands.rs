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
        claude_code, coach, coach::Backend, features, ingest, store::Store, uci::UciEngine,
        CoachSettings, CoachSettingsUpdate, CoachSettingsView, DrillCard, DrillLine, IngestOptions,
        maia::{self, MaiaPaths, MaiaStatus},
        CoachPuzzle, DayActivity, EndgameAttempt, EndgameStat, IngestSummary, Insight, MaiaGameRecord, MaiaSummary, Mistake,
        TodayCounts,
        MistakeContext, MistakeFilter,
        PuzzleAttempt, PuzzleProfile, TrainingError, TrainingStats, PROVIDER_API,
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

#[derive(Clone, Copy)]
enum Task {
    Explain,
    Insight,
}

/// Pick the AI backend for a task from the settings.
fn backend(s: &CoachSettings, task: Task) -> Result<Backend, Error> {
    if s.provider == PROVIDER_API {
        let key = s
            .api_key
            .clone()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| Error::Training("Add your Anthropic API key in Coach → Settings first.".into()))?;
        return Ok(Backend::Api { key, model: s.model.clone() });
    }
    let exe = claude_code::find_claude(s.claude_path.as_deref()).ok_or_else(|| {
        Error::Training(
            "Claude Code wasn't found. Install it (claude.com/claude-code), sign in once, \
             or set its location in Coach → Settings."
                .into(),
        )
    })?;
    let model = match task {
        Task::Explain => s.explain_model.clone(),
        Task::Insight => s.insight_model.clone(),
    };
    Ok(Backend::ClaudeCode { exe, model })
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
        if let Ok(b) = backend(&settings, Task::Insight) {
            let since_last = {
                let store = Store::open(&db)?;
                let now = store.serious_mistake_count()?;
                let at_last = store.latest_insight()?.map(|i| i.mistakes_analyzed).unwrap_or(0);
                now.saturating_sub(at_last)
            };
            if since_last >= settings.auto_insight_every {
                match coach::analyze_patterns(&b, &db).await {
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
    let b = backend(&load_settings(&app)?, Task::Explain)?;
    Ok(coach::explain_mistake(&b, &db, mistake_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_run_insights(app: tauri::AppHandle) -> Result<Option<Insight>, Error> {
    let db = db_path(&app)?;
    let b = backend(&load_settings(&app)?, Task::Insight)?;
    coach::analyze_patterns(&b, &db).await?;
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
    let usage_7d = Store::open(&db_path(&app)?)?.usage_last_days(7)?;
    Ok(CoachSettingsView {
        has_api_key: s.api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        detected_claude_path: claude_code::find_claude(s.claude_path.as_deref())
            .map(|p| p.display().to_string()),
        provider: s.provider,
        model: s.model,
        claude_path: s.claude_path,
        explain_model: s.explain_model,
        insight_model: s.insight_model,
        auto_insight_every: s.auto_insight_every,
        usage_7d,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn training_set_settings(
    update: CoachSettingsUpdate,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    let p = settings_path(&app)?;
    let mut s: CoachSettings = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Some(k) = update.api_key {
        s.api_key = if k.trim().is_empty() { None } else { Some(k.trim().to_string()) };
    }
    s.provider = update.provider;
    s.model = update.model;
    s.claude_path = update.claude_path.filter(|p| !p.trim().is_empty());
    s.explain_model = update.explain_model;
    s.insight_model = update.insight_model;
    s.auto_insight_every = update.auto_insight_every;
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

/// One engine kept alive between drill moves (spawning Stockfish per move is slow).
static DRILL_ENGINE: once_cell::sync::Lazy<tokio::sync::Mutex<Option<(String, UciEngine)>>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(None));

/// Analyse a drill position locally with Stockfish (never uses Claude).
/// Scores are from the side to move's point of view.
#[tauri::command]
#[specta::specta]
pub async fn training_analyse(
    engine_path: String,
    fen: String,
    depth: u32,
    multipv: u32,
) -> Result<Vec<DrillLine>, Error> {
    let pos = features::parse_fen(&fen).ok_or_else(|| Error::Training("invalid position".into()))?;
    if shakmaty::Position::is_game_over(&pos) {
        return Ok(vec![]);
    }
    let mut guard = DRILL_ENGINE.lock().await;
    if guard.as_ref().map(|(p, _)| p != &engine_path).unwrap_or(true) {
        if let Some((_, old)) = guard.take() {
            old.quit().await;
        }
        let e = UciEngine::spawn(&engine_path, 2, 64).await?;
        *guard = Some((engine_path.clone(), e));
    }
    let (_, engine) = guard.as_mut().expect("engine just set");
    match engine.analyse(&fen, &[], depth.clamp(6, 24), multipv.clamp(1, 4)).await {
        Ok(lines) => Ok(features::to_drill_lines(&pos, &lines)),
        Err(e) => {
            // Drop a broken engine so the next call starts a fresh one.
            *guard = None;
            Err(e.into())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn training_mistake_context(
    mistake_id: i64,
    app: tauri::AppHandle,
) -> Result<MistakeContext, Error> {
    Ok(Store::open(&db_path(&app)?)?.mistake_context(mistake_id)?)
}

/// Puzzles for a coach weakness: any of `themes`, within `[min_rating, max_rating]`,
/// skipping puzzles you've already attempted in the Coach.
#[tauri::command]
#[specta::specta]
pub async fn training_themed_puzzles(
    file: String,
    themes: Vec<String>,
    min_rating: i32,
    max_rating: i32,
    count: u32,
    app: tauri::AppHandle,
) -> Result<Vec<CoachPuzzle>, Error> {
    let seen = Store::open(&db_path(&app)?)?.attempted_puzzle_ids()?;
    let want = count.clamp(1, 50) as usize;
    let rows = tokio::task::spawn_blocking(move || {
        crate::puzzle::themed_puzzles(&file, &themes, min_rating, max_rating, (want * 3) as i64)
    })
    .await
    .map_err(|e| Error::Training(e.to_string()))??;
    Ok(rows
        .into_iter()
        .filter(|r| !seen.contains(&r.0))
        .take(want)
        .map(|(id, fen, moves, rating, themes)| CoachPuzzle {
            id,
            fen,
            moves: moves.split_whitespace().map(|m| m.to_string()).collect(),
            rating,
            themes,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn training_record_puzzle(
    attempt: PuzzleAttempt,
    app: tauri::AppHandle,
) -> Result<PuzzleProfile, Error> {
    let store = Store::open(&db_path(&app)?)?;
    store.record_puzzle_attempt(&attempt)?;
    Ok(store.puzzle_profile()?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_puzzle_profile(app: tauri::AppHandle) -> Result<PuzzleProfile, Error> {
    Ok(Store::open(&db_path(&app)?)?.puzzle_profile()?)
}

// ---------------------------------------------------------------------------------------
// Maia-3: human-like opponent
// ---------------------------------------------------------------------------------------

pub const MAIA_INSTALL_PROGRESS_ID: &str = "maia_install";

fn maia_paths(app: &tauri::AppHandle) -> Result<MaiaPaths, Error> {
    Ok(MaiaPaths::new(data_dir(app)?.join("coach").join("maia3")))
}

/// The running Maia-3 engine and the Elo it's currently set to.
static MAIA_ENGINE: once_cell::sync::Lazy<tokio::sync::Mutex<Option<(i32, UciEngine)>>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(None));

#[tauri::command]
#[specta::specta]
pub async fn training_maia_status(app: tauri::AppHandle) -> Result<MaiaStatus, Error> {
    Ok(maia_paths(&app)?.status())
}

/// One-time setup (uv → private Python → torch + Maia-3 → model → smoke test).
/// Progress is reported on the "maia_install" progress id.
#[tauri::command]
#[specta::specta]
pub async fn training_maia_install(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<MaiaStatus, Error> {
    let paths = maia_paths(&app)?;
    let progress_app = app.clone();
    let result = maia::install(&paths, &maia::InstallSpec::default(), move |p, _msg| {
        let st = progress_app.state::<AppState>();
        let _ = update_progress(
            &st.progress_state,
            &progress_app,
            MAIA_INSTALL_PROGRESS_ID.to_string(),
            p,
            false,
        );
    })
    .await;
    update_progress(
        &state.progress_state,
        &app,
        MAIA_INSTALL_PROGRESS_ID.to_string(),
        100.0,
        true,
    )?;
    result?;
    Ok(paths.status())
}

#[tauri::command]
#[specta::specta]
pub async fn training_maia_uninstall(app: tauri::AppHandle) -> Result<MaiaStatus, Error> {
    if let Some((_, e)) = MAIA_ENGINE.lock().await.take() {
        e.quit().await;
    }
    let paths = maia_paths(&app)?;
    if paths.root.exists() {
        std::fs::remove_dir_all(&paths.root)?;
    }
    Ok(paths.status())
}

/// Maia-3's move at `elo` (Lichess blitz scale) for the position after `moves` from `start_fen`.
#[tauri::command]
#[specta::specta]
pub async fn training_maia_move(
    start_fen: String,
    moves: Vec<String>,
    elo: i32,
    app: tauri::AppHandle,
) -> Result<Option<String>, Error> {
    let paths = maia_paths(&app)?;
    if !paths.status().installed {
        return Err(Error::Training("Set up the human-like opponent first.".into()));
    }
    let mut guard = MAIA_ENGINE.lock().await;
    if guard.is_none() {
        let e = UciEngine::spawn_with(&paths.engine().display().to_string(), &paths.engine_args(), &[]).await?;
        *guard = Some((-1, e));
    }
    let (current_elo, engine) = guard.as_mut().expect("engine just set");
    let elo = elo.clamp(600, 2600);
    if *current_elo != elo {
        // Maia plays as `elo` and assumes an opponent of similar strength.
        engine.set_option("SelfElo", &elo.to_string()).await?;
        engine.set_option("OppoElo", &elo.to_string()).await?;
        *current_elo = elo;
    }
    match engine.best_move(&start_fen, &moves, "nodes 1").await {
        Ok(m) => Ok(m),
        Err(e) => {
            *guard = None;
            Err(e.into())
        }
    }
}

/// Save a finished game: stats row + appended to the Coach's PGN file (returned path),
/// which the frontend then runs through the normal mistake analysis.
#[tauri::command]
#[specta::specta]
pub async fn training_maia_record_game(
    game: MaiaGameRecord,
    app: tauri::AppHandle,
) -> Result<String, Error> {
    let store = Store::open(&db_path(&app)?)?;
    store.record_maia_game(&game)?;
    let pgn_path = data_dir(&app)?.join("coach").join("maia-games.pgn");
    if let Some(dir) = pgn_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&pgn_path)?;
    writeln!(f, "{}\n", game.pgn.trim())?;
    Ok(pgn_path.display().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn training_maia_summary(app: tauri::AppHandle) -> Result<MaiaSummary, Error> {
    Ok(Store::open(&db_path(&app)?)?.maia_summary()?)
}

// ---------------------------------------------------------------------------------------
// Daily lesson
// ---------------------------------------------------------------------------------------

/// Today's activity (by your local date) for ticking off the lesson checklist.
#[tauri::command]
#[specta::specta]
pub async fn training_today(tz_offset_minutes: i32, app: tauri::AppHandle) -> Result<TodayCounts, Error> {
    Ok(Store::open(&db_path(&app)?)?.today_counts(tz_offset_minutes)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_history(
    days: u32,
    tz_offset_minutes: i32,
    app: tauri::AppHandle,
) -> Result<Vec<DayActivity>, Error> {
    Ok(Store::open(&db_path(&app)?)?.history(days.clamp(1, 120), tz_offset_minutes)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_set_mark(
    date: String,
    mark: String,
    on: bool,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    Ok(Store::open(&db_path(&app)?)?.set_mark(&date, &mark, on)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_lookback_mistake(
    tz_offset_minutes: i32,
    app: tauri::AppHandle,
) -> Result<Option<Mistake>, Error> {
    Ok(Store::open(&db_path(&app)?)?.lookback_mistake(tz_offset_minutes)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_endgame_record(
    attempt: EndgameAttempt,
    tz_offset_minutes: i32,
    app: tauri::AppHandle,
) -> Result<Vec<EndgameStat>, Error> {
    let store = Store::open(&db_path(&app)?)?;
    store.record_endgame(&attempt)?;
    Ok(store.endgame_stats(tz_offset_minutes)?)
}

#[tauri::command]
#[specta::specta]
pub async fn training_endgame_stats(
    tz_offset_minutes: i32,
    app: tauri::AppHandle,
) -> Result<Vec<EndgameStat>, Error> {
    Ok(Store::open(&db_path(&app)?)?.endgame_stats(tz_offset_minutes)?)
}
