//! Personal training module ("Coach").
//!
//! Pipeline:
//!   PGN file (your Chess.com / Lichess downloads)
//!     -> `ingest`   : parse mainline moves + clocks + headers
//!     -> `uci`      : run a UCI engine over every position (MultiPV 2)
//!     -> `features` : turn eval swings into tagged mistakes (hung piece, missed fork, rushed, ...)
//!     -> `store`    : persist into a private SQLite file (training.db)
//!     -> `coach`    : send *verified facts* (never raw guessing) to Claude for
//!                     per-mistake explanations and cross-game pattern analysis.
//!
//! Everything in this folder is independent of Tauri so it can be unit tested on its own;
//! the Tauri command layer lives in `crate::training_commands`.

pub mod claude_code;
pub mod coach;
pub mod features;
pub mod ingest;
pub mod store;
pub mod uci;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, thiserror::Error)]
pub enum TrainingError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Msg(String),
}

pub type TResult<T> = Result<T, TrainingError>;

pub fn msg<T>(s: impl Into<String>) -> TResult<T> {
    Err(TrainingError::Msg(s.into()))
}

/// How hard the engine should look at each position during batch analysis.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IngestOptions {
    /// Path to a UCI engine binary (Stockfish recommended).
    pub engine_path: String,
    /// Your username on the site the PGN came from (case-insensitive).
    pub player: String,
    /// Search depth per position. 12–16 is a good speed/quality trade-off for blunder finding.
    pub depth: u32,
    pub threads: u32,
    pub hash_mb: u32,
    /// Stop after this many *new* games (newest first). `None` = all.
    pub max_games: Option<u32>,
    /// Ignore games shorter than this many plies (aborts, early resignations).
    pub min_plies: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub games_seen: u32,
    pub games_analyzed: u32,
    pub games_skipped: u32,
    pub mistakes_found: u32,
    pub cancelled: bool,
    /// True if the AI pattern analysis was refreshed automatically after this run.
    pub insight_refreshed: bool,
}

/// One stored mistake, as returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Mistake {
    pub id: i64,
    pub game_id: String,
    pub ply: u32,
    pub fen_before: String,
    pub player_color: String,
    pub played_uci: String,
    pub played_san: String,
    pub best_uci: String,
    pub best_san: String,
    /// Best line from the position, in SAN, space separated.
    pub best_line: String,
    /// Opponent's best reply line after your move, in SAN.
    pub refutation_line: String,
    pub eval_before_cp: i32,
    pub eval_after_cp: i32,
    pub win_before: f32,
    pub win_after: f32,
    pub win_drop: f32,
    /// "inaccuracy" | "mistake" | "blunder"
    pub severity: String,
    /// "opening" | "middlegame" | "endgame"
    pub phase: String,
    pub moved_role: String,
    pub clock_secs: Option<f32>,
    pub time_spent_secs: Option<f32>,
    pub tags: Vec<String>,
    // game context
    pub opponent: String,
    pub opening: Option<String>,
    pub time_control: Option<String>,
    pub date: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MistakeFilter {
    pub tag: Option<String>,
    pub phase: Option<String>,
    pub severity: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CountRow {
    pub key: String,
    pub count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingStats {
    pub games: u32,
    pub mistakes: u32,
    pub blunders: u32,
    /// Mistakes (not inaccuracies) per game, overall.
    pub mistakes_per_game: f32,
    pub by_tag: Vec<CountRow>,
    pub by_phase: Vec<CountRow>,
    pub by_opening: Vec<CountRow>,
    pub by_time_control: Vec<CountRow>,
    pub by_piece: Vec<CountRow>,
    /// Month ("2026-11") -> mistakes per game that month.
    pub monthly_rate: Vec<MonthlyRate>,
    pub cards_due: u32,
    pub cards_total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyRate {
    pub month: String,
    pub games: u32,
    pub mistakes_per_game: f32,
}

/// Spaced-repetition card for a mistake. The FSRS state itself is computed in the
/// frontend with ts-fsrs (same library the repertoire trainer uses); Rust just stores it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DrillCard {
    pub mistake: Mistake,
    /// JSON-serialized ts-fsrs `Card`, or null for a brand-new card.
    pub card_json: Option<String>,
    /// True if this card targets one of the coach's current focus weaknesses.
    pub focus: bool,
}

/// Structured output of the AI pattern analysis (see `coach::INSIGHT_TOOL`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: i64,
    pub created_at: String,
    pub mistakes_analyzed: u32,
    pub summary: String,
    pub weaknesses: Vec<Weakness>,
    pub strengths: Vec<String>,
    pub plan: Vec<String>,
    pub progress_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Weakness {
    pub title: String,
    pub evidence: String,
    #[serde(alias = "rule_of_thumb")]
    pub rule_of_thumb: String,
    #[serde(default, alias = "mistake_ids")]
    pub mistake_ids: Vec<i64>,
    /// Mistake tags the drill queue should prioritise for this weakness.
    #[serde(default, alias = "drill_tags")]
    pub drill_tags: Vec<String>,
    /// Lichess puzzle themes to practise (e.g. "fork", "hangingPiece").
    #[serde(default, alias = "puzzle_themes")]
    pub puzzle_themes: Vec<String>,
    pub priority: u8,
}

/// Which service answers the coach's questions.
pub const PROVIDER_CLAUDE_CODE: &str = "claudeCode";
pub const PROVIDER_API: &str = "api";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct CoachSettings {
    /// "claudeCode" (uses your Claude subscription) or "api" (pay-per-use API key).
    pub provider: String,
    pub api_key: Option<String>,
    /// Model for the API provider.
    pub model: String,
    /// Optional explicit path to claude.exe; auto-detected when empty.
    pub claude_path: Option<String>,
    /// Claude Code model for per-mistake explanations (cheap is fine).
    pub explain_model: String,
    /// Claude Code model for the cross-game pattern analysis.
    pub insight_model: String,
    /// Re-run pattern analysis automatically after this many new mistakes (0 = never).
    pub auto_insight_every: u32,
}

impl Default for CoachSettings {
    fn default() -> Self {
        Self {
            provider: PROVIDER_CLAUDE_CODE.to_string(),
            api_key: None,
            model: "claude-sonnet-5-5".to_string(),
            claude_path: None,
            explain_model: "haiku".to_string(),
            insight_model: "sonnet".to_string(),
            auto_insight_every: 40,
        }
    }
}

/// Token usage of coach calls over the last 7 days.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub calls: u32,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// What the UI is allowed to see about the settings (never the key itself).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoachSettingsView {
    pub provider: String,
    pub has_api_key: bool,
    pub model: String,
    pub claude_path: Option<String>,
    /// Where Claude Code was found (None = not installed / not found).
    pub detected_claude_path: Option<String>,
    pub explain_model: String,
    pub insight_model: String,
    pub auto_insight_every: u32,
    pub usage_7d: UsageSummary,
}

/// Settings update from the UI. `api_key`: None keeps the current key, Some("") removes it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoachSettingsUpdate {
    pub provider: String,
    pub api_key: Option<String>,
    pub model: String,
    pub claude_path: Option<String>,
    pub explain_model: String,
    pub insight_model: String,
    pub auto_insight_every: u32,
}
