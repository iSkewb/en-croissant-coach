//! The AI layer. Two jobs:
//!   1. `explain_mistake`  – a short, personalised explanation of one mistake.
//!   2. `analyze_patterns` – cross-game pattern analysis that produces your current
//!      weaknesses, a training plan, and which mistake tags the drill queue should prioritise.
//!
//! Two backends: Claude Code (`claude -p`, uses your Claude subscription) or the
//! pay-per-use API. Prompts are deliberately compact to keep usage low: short keys,
//! only the tag definitions that actually appear, truncated lines, a small sample.
//!
//! The model never sees a bare FEN and is never asked to calculate. It receives engine lines
//! and facts verified by `features::explain_facts`, and is told to use only those.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{
    claude_code, features::explain_facts, msg, store::tc_bucket, store::Store, Mistake,
    TResult, TrainingError, TrainingStats,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

/// Plain-English meaning of every tag the detector can produce.
pub const TAG_GLOSSARY: &[(&str, &str)] = &[
    ("hung_piece", "Left a piece (knight or better) that the opponent could win immediately"),
    ("moved_piece_en_prise", "Moved a piece to a square where it could simply be taken"),
    ("ignored_threat", "Opponent was already attacking a piece and the move didn't deal with it"),
    ("removed_defender", "The move took away a defender or opened a line, so another piece became loose"),
    ("allowed_fork", "Allowed a reply that attacks two or more valuable targets at once"),
    ("allowed_mate", "Allowed a forced checkmate"),
    ("allowed_king_attack", "Allowed a checking attack that wins material or position"),
    ("missed_mate", "Had a forced mate and didn't play it"),
    ("missed_fork", "Missed a move that attacks two or more valuable targets at once"),
    ("missed_free_piece", "Missed capturing a piece that was free or under-defended"),
    ("lost_material", "The opponent's best line wins 2+ points of material after the move"),
    ("missed_material", "The best line would have won 2+ points more material than the move played"),
    ("positional", "No immediate tactic: a strategic/plan error (structure, activity, king safety, trades)"),
    ("was_winning", "Made the mistake while clearly winning (conversion problem)"),
    ("was_losing", "Made the mistake while already worse"),
    ("time_pressure", "Had under 10% of the base time (min 30s) left"),
    ("rushed", "Spent 3 seconds or less on the move outside time trouble"),
];

/// Lichess puzzle themes the coach may recommend (matches the puzzle database themes).
pub const PUZZLE_THEMES: &[&str] = &[
    "fork", "pin", "skewer", "hangingPiece", "trappedPiece", "discoveredAttack",
    "doubleCheck", "deflection", "attraction", "clearance", "interference", "xRayAttack",
    "intermezzo", "quietMove", "defensiveMove", "zugzwang", "capturingDefender",
    "mateIn1", "mateIn2", "mateIn3", "backRankMate", "smotheredMate", "kingsideAttack",
    "queensideAttack", "exposedKing", "sacrifice", "advancedPawn", "promotion",
    "opening", "middlegame", "endgame", "rookEndgame", "pawnEndgame", "bishopEndgame",
    "knightEndgame", "queenEndgame", "crushing", "advantage", "equality",
];

/// Where a request goes. Built per task by the command layer from the settings.
#[derive(Debug, Clone)]
pub enum Backend {
    ClaudeCode { exe: PathBuf, model: String },
    Api { key: String, model: String },
}

impl Backend {
    fn provider(&self) -> &'static str {
        match self {
            Backend::ClaudeCode { .. } => "claudeCode",
            Backend::Api { .. } => "api",
        }
    }
    fn model(&self) -> &str {
        match self {
            Backend::ClaudeCode { model, .. } | Backend::Api { model, .. } => model,
        }
    }

    /// One prompt in, text out. Returns (text, input tokens, output tokens).
    async fn complete(&self, system: &str, user: &str, max_tokens: u32) -> TResult<(String, u64, u64)> {
        match self {
            Backend::ClaudeCode { exe, model } => {
                // Keep the CLI's system prompt to one line; the real instructions go in the
                // prompt (stdin), which avoids command-line quoting issues on Windows.
                let prompt = format!("{system}\n\n---\n{user}");
                let (text, u) = claude_code::run(
                    exe,
                    model,
                    "low",
                    "You are a concise chess coach. Follow the instructions in the message exactly.",
                    &prompt,
                )
                .await?;
                Ok((text, u.input_tokens + u.cache_read_tokens, u.output_tokens))
            }
            Backend::Api { key, model } => {
                let body = json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                });
                let resp = call_api(key, body).await?;
                let text = resp["content"]
                    .as_array()
                    .map(|b| b.iter().filter_map(|x| x["text"].as_str()).collect::<String>())
                    .unwrap_or_default();
                Ok((
                    text,
                    resp["usage"]["input_tokens"].as_u64().unwrap_or(0),
                    resp["usage"]["output_tokens"].as_u64().unwrap_or(0),
                ))
            }
        }
    }
}

async fn call_api(api_key: &str, body: Value) -> TResult<Value> {
    let client = reqwest::Client::new();
    let res = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body)?)
        .send()
        .await?;
    let status = res.status();
    let text = res.text().await?;
    if !status.is_success() {
        return msg(format!("Claude API error {status}: {text}"));
    }
    Ok(serde_json::from_str(&text)?)
}

/// Definitions for just the tags that appear (saves tokens vs. the full glossary).
fn glossary_for<'a>(tags: impl IntoIterator<Item = &'a str>) -> String {
    let wanted: std::collections::HashSet<&str> = tags.into_iter().collect();
    TAG_GLOSSARY
        .iter()
        .filter(|(k, _)| wanted.contains(k))
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn pawns(cp: i32) -> String {
    if cp.abs() >= 1000 {
        if cp > 0 { "mate+".into() } else { "mate-".into() }
    } else {
        format!("{:+.1}", cp as f32 / 100.0)
    }
}

fn first_plies(line: &str, n: usize) -> String {
    line.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

/// Compact, verified description of one mistake. `full` adds lines and all facts
/// (for explanations); the short form is for the pattern-analysis sample.
pub fn mistake_brief(store: &Store, m: &Mistake, full: bool) -> TResult<Value> {
    let (best, refut) = store.get_mistake_lines(m.id)?;
    let mut facts = explain_facts(&m.fen_before, &m.played_uci, &best, &refut);
    if !full {
        facts.truncate(2);
    }
    let mut o = Map::new();
    o.insert("id".into(), json!(m.id));
    o.insert("tc".into(), json!(tc_bucket(m.time_control.as_deref())));
    o.insert("opening".into(), json!(m.opening));
    o.insert("move".into(), json!(m.ply / 2 + 1));
    o.insert("color".into(), json!(m.player_color));
    o.insert("phase".into(), json!(m.phase));
    o.insert("sev".into(), json!(m.severity));
    o.insert("played".into(), json!(m.played_san));
    o.insert("best".into(), json!(m.best_san));
    o.insert("eval".into(), json!(format!("{}→{}", pawns(m.eval_before_cp), pawns(m.eval_after_cp))));
    if let Some(s) = m.time_spent_secs {
        o.insert("secs".into(), json!(s.round() as i32));
    }
    o.insert("tags".into(), json!(m.tags));
    if full {
        o.insert("best_line".into(), json!(first_plies(&m.best_line, 6)));
        o.insert("their_reply_line".into(), json!(first_plies(&m.refutation_line, 6)));
        if let Some(c) = m.clock_secs {
            o.insert("clock".into(), json!(c.round() as i32));
        }
    }
    if !facts.is_empty() {
        o.insert("facts".into(), json!(facts));
    }
    Ok(Value::Object(o))
}

/// Stats trimmed to what matters for coaching.
fn compact_stats(s: &TrainingStats) -> Value {
    let rows = |r: &[super::CountRow], n: usize| -> Value {
        Value::Object(r.iter().take(n).map(|c| (c.key.clone(), json!(c.count))).collect())
    };
    let months: Vec<Value> = s
        .monthly_rate
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|m| json!([m.month, m.games, (m.mistakes_per_game * 10.0).round() / 10.0]))
        .collect();
    json!({
        "games": s.games,
        "mistakes": s.mistakes,
        "blunders": s.blunders,
        "per_game": (s.mistakes_per_game * 10.0).round() / 10.0,
        "by_tag": rows(&s.by_tag, 12),
        "by_phase": rows(&s.by_phase, 3),
        "by_tc": rows(&s.by_time_control, 4),
        "by_piece": rows(&s.by_piece, 6),
        "by_opening": rows(&s.by_opening, 5),
        "months[month,games,per_game]": months,
    })
}

fn log_usage(store_path: &Path, kind: &str, b: &Backend, input: u64, output: u64) {
    if let Ok(store) = Store::open(store_path) {
        let _ = store.log_usage(kind, b.provider(), b.model(), input, output);
    }
}

/// Builds the request synchronously (the SQLite handle never crosses an `.await`,
/// which keeps these futures `Send` for Tauri), asks Claude, then caches the answer.
pub async fn explain_mistake(backend: &Backend, store_path: &Path, mistake_id: i64) -> TResult<String> {
    let (system, user) = {
        let store = Store::open(store_path)?;
        let Some(m) = store.get_mistake(mistake_id)? else {
            return msg("mistake not found");
        };
        let brief = mistake_brief(&store, &m, true)?;
        let history: Value = Value::Object(
            store
                .tag_counts(&m.tags)?
                .into_iter()
                .map(|c| (c.key, json!(c.count)))
                .collect(),
        );
        let focus: Vec<String> = store
            .latest_insight()?
            .map(|i| i.weaknesses.into_iter().map(|w| w.title).collect())
            .unwrap_or_default();
        let system = format!(
            "Explain ONE mistake from the player's own game to an improving club player who wants the why.\n\
             Rules: use ONLY the moves, lines and facts given; never invent pieces, squares or tactics. \
             If facts are thin, call it positional and explain via the best line. SAN as given. \
             Under 110 words, plain text, no headings or lists. Structure: what went wrong (1-2 sentences); \
             the idea behind the better move; a final line starting 'Rule:' with one habit. \
             If history shows a tag recurring (count ≥3), mention it briefly.\n\
             Tags:\n{}",
            glossary_for(m.tags.iter().map(|s| s.as_str()))
        );
        let mut user = json!({ "mistake": brief, "tag_history": history });
        if !focus.is_empty() {
            user["focus_weaknesses"] = json!(focus);
        }
        (system, user.to_string())
    };
    let (text, i, o) = backend.complete(&system, &user, 500).await?;
    log_usage(store_path, "explain", backend, i, o);
    let text = text.trim();
    if text.is_empty() {
        return msg("Empty answer from Claude.");
    }
    Store::open(store_path)?.save_explanation(mistake_id, text, backend.model())?;
    Ok(text.to_string())
}

/// Schema the insight answer must follow (API: forced tool call; Claude Code: JSON in text).
fn insight_schema() -> Value {
    let tag_names: Vec<&str> = TAG_GLOSSARY.iter().map(|(k, _)| *k).collect();
    json!({
        "type": "object",
        "required": ["summary", "weaknesses", "strengths", "plan", "progress_note"],
        "properties": {
            "summary": { "type": "string", "description": "2-3 sentence overview of the player's error profile." },
            "weaknesses": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                    "type": "object",
                    "required": ["title", "evidence", "rule_of_thumb", "mistake_ids", "drill_tags", "puzzle_themes", "priority"],
                    "properties": {
                        "title": { "type": "string" },
                        "evidence": { "type": "string", "description": "Numbers/patterns from the data." },
                        "rule_of_thumb": { "type": "string", "description": "One habit, phrased as an instruction." },
                        "mistake_ids": { "type": "array", "items": { "type": "integer" } },
                        "drill_tags": { "type": "array", "items": { "type": "string", "enum": tag_names } },
                        "puzzle_themes": { "type": "array", "items": { "type": "string", "enum": PUZZLE_THEMES } },
                        "priority": { "type": "integer", "minimum": 1, "maximum": 3 }
                    }
                }
            },
            "strengths": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
            "plan": { "type": "array", "items": { "type": "string" }, "minItems": 3, "maxItems": 6 },
            "progress_note": { "type": "string" }
        }
    })
}

/// Compact text version of the schema for the Claude Code prompt (fewer tokens than JSON Schema).
fn insight_format_text() -> String {
    format!(
        "Reply with ONLY one JSON object, no prose, no code fences:\n\
         {{\"summary\":str (2-3 sentences),\n\
          \"weaknesses\":[{{\"title\":str,\"evidence\":str (numbers from data),\"rule_of_thumb\":str,\
         \"mistake_ids\":[int, 2-6 from examples],\"drill_tags\":[tag],\"puzzle_themes\":[theme],\"priority\":1|2|3}}] (1-4 items),\n\
          \"strengths\":[str] (≤3),\"plan\":[str] (3-6 concrete practice items for this week),\"progress_note\":str}}\n\
         Allowed puzzle themes: {}",
        PUZZLE_THEMES.join(",")
    )
}

/// Cross-game pattern analysis. Saves and returns the raw JSON.
pub async fn analyze_patterns(backend: &Backend, store_path: &Path) -> TResult<String> {
    let (system, user, mistakes_now) = {
        let store = Store::open(store_path)?;
        let stats = store.stats()?;
        if stats.mistakes < 5 {
            return msg("Analyse a few more games first (need at least 5 mistakes).");
        }
        // Small, representative sample: 2 per common pattern + 6 most recent.
        let sample = store.sample_for_insight(2, 6)?;
        let examples: Vec<Value> = sample
            .iter()
            .map(|m| mistake_brief(&store, m, false))
            .collect::<TResult<_>>()?;
        let previous = store.latest_insight()?.map(|p| {
            json!({
                "date": p.created_at,
                "mistakes_then": p.mistakes_analyzed,
                "weaknesses": p.weaknesses.iter().map(|w| &w.title).collect::<Vec<_>>(),
            })
        });
        let system = format!(
            "You coach a club player using stats over all their analysed games plus sample mistakes \
             (engine lines and verified facts). Find the 2-4 recurring weaknesses that cost the most, ranked. \
             Prefer behavioural root causes (e.g. 'stops checking threats after a capture', 'plays too fast \
             when winning') over restating tags. Back every claim with numbers or example ids. If puzzle \
             results are given, use them in progress_note (improving or not per weakness). Do not invent \
             tactics beyond the facts. drill_tags must come from the tag list.\nTags:\n{}",
            glossary_for(stats.by_tag.iter().map(|r| r.key.as_str()))
        );
        let mut user = json!({ "stats": compact_stats(&stats), "examples": examples });
        if let Some(p) = previous {
            user["previous"] = p;
        }
        // Puzzle practice results per theme, so the coach can see whether weaknesses improve.
        let profile = store.puzzle_profile()?;
        if profile.attempts > 0 {
            let themes: Map<String, Value> = profile
                .theme_stats
                .iter()
                .take(8)
                .map(|t| {
                    (
                        t.theme.clone(),
                        json!([t.attempts, t.solved, t.recent_attempts, t.recent_solved]),
                    )
                })
                .collect();
            user["puzzles[attempts,solved,7d_attempts,7d_solved]"] = Value::Object(themes);
            user["puzzle_rating"] = json!(profile.rating);
        }
        (system, user.to_string(), stats.mistakes)
    };

    let (input_json, i, o) = match backend {
        Backend::Api { key, model } => {
            let body = json!({
                "model": model,
                "max_tokens": 2000,
                "system": system,
                "tools": [{ "name": "report_insights", "description": "Report weaknesses and plan.", "input_schema": insight_schema() }],
                "tool_choice": { "type": "tool", "name": "report_insights" },
                "messages": [{ "role": "user", "content": user }],
            });
            let resp = call_api(key, body).await?;
            let input = resp["content"]
                .as_array()
                .and_then(|b| b.iter().find(|x| x["type"] == "tool_use"))
                .map(|x| x["input"].clone())
                .ok_or_else(|| TrainingError::Msg("Claude did not return insights".into()))?;
            (
                input,
                resp["usage"]["input_tokens"].as_u64().unwrap_or(0),
                resp["usage"]["output_tokens"].as_u64().unwrap_or(0),
            )
        }
        Backend::ClaudeCode { .. } => {
            let system = format!("{system}\n\n{}", insight_format_text());
            let (text, i, o) = backend.complete(&system, &user, 2000).await?;
            (claude_code::extract_json(&text)?, i, o)
        }
    };
    log_usage(store_path, "insight", backend, i, o);

    // Validate the shape before storing it.
    for key in ["summary", "weaknesses", "plan"] {
        if input_json.get(key).is_none() {
            return msg(format!("The coach's answer was missing '{key}'. Try again."));
        }
    }
    let _: Vec<super::Weakness> = serde_json::from_value(input_json["weaknesses"].clone())
        .map_err(|e| TrainingError::Msg(format!("The coach's answer had an unexpected format: {e}")))?;

    let json_str = serde_json::to_string(&input_json)?;
    Store::open(store_path)?.save_insight(mistakes_now, &json_str)?;
    Ok(json_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glossary_only_includes_requested_tags() {
        let g = glossary_for(["hung_piece", "rushed"]);
        assert!(g.contains("hung_piece") && g.contains("rushed"));
        assert!(!g.contains("missed_mate"));
    }

    #[test]
    fn line_truncation() {
        assert_eq!(first_plies("a b c d e f g h", 3), "a b c");
    }
}
