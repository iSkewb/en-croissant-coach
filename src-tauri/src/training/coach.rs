//! The AI layer. Two jobs:
//!   1. `explain_mistake`  – a short, personalised explanation of one mistake.
//!   2. `analyze_patterns` – cross-game pattern analysis that produces your current
//!      weaknesses, a training plan, and which mistake tags the drill queue should prioritise.
//!
//! The model never sees a bare FEN and is never asked to calculate. It receives engine lines
//! and facts verified by `features::explain_facts`, and is told to use only those.

use std::path::Path;

use serde_json::{json, Value};

use super::{
    features::explain_facts, msg, store::tc_bucket, store::Store, Mistake, TResult,
    TrainingError,
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

fn glossary_text() -> String {
    TAG_GLOSSARY
        .iter()
        .map(|(k, v)| format!("- {k}: {v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn call_claude(api_key: &str, body: Value) -> TResult<Value> {
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

fn pawns(cp: i32) -> String {
    if cp.abs() >= 1000 {
        if cp > 0 { "winning (mate)".into() } else { "lost (mate)".into() }
    } else {
        format!("{:+.1}", cp as f32 / 100.0)
    }
}

/// Compact, verified description of one mistake for the model.
pub fn mistake_brief(store: &Store, m: &Mistake, with_facts: bool) -> TResult<Value> {
    let facts = if with_facts {
        let (best, refut) = store.get_mistake_lines(m.id)?;
        explain_facts(&m.fen_before, &m.played_uci, &best, &refut)
    } else {
        vec![]
    };
    Ok(json!({
        "id": m.id,
        "date": m.date,
        "time_control": tc_bucket(m.time_control.as_deref()),
        "opening": m.opening,
        "you_played_as": m.player_color,
        "move_number": m.ply / 2 + 1,
        "phase": m.phase,
        "severity": m.severity,
        "piece_moved": m.moved_role,
        "played": m.played_san,
        "best": m.best_san,
        "best_line": m.best_line,
        "opponent_best_reply_line": m.refutation_line,
        "eval_before_your_view": pawns(m.eval_before_cp),
        "eval_after_your_view": pawns(m.eval_after_cp),
        "win_chance_before": (m.win_before as i32),
        "win_chance_after": (m.win_after as i32),
        "seconds_spent": m.time_spent_secs.map(|s| s.round() as i32),
        "clock_left": m.clock_secs.map(|s| s.round() as i32),
        "tags": m.tags,
        "verified_facts": facts,
    }))
}

/// Builds the request synchronously (the SQLite handle never crosses an `.await`,
/// which keeps these futures `Send` for Tauri), calls Claude, then caches the answer.
pub async fn explain_mistake(
    api_key: &str,
    model: &str,
    store_path: &Path,
    mistake_id: i64,
) -> TResult<String> {
    let (brief, history, focus) = {
        let store = Store::open(store_path)?;
        let Some(m) = store.get_mistake(mistake_id)? else {
            return msg("mistake not found");
        };
        let brief = mistake_brief(&store, &m, true)?;
        let history = store.tag_counts(&m.tags)?;
        let focus = store
            .latest_insight()?
            .map(|i| i.weaknesses.into_iter().map(|w| w.title).collect::<Vec<_>>())
            .unwrap_or_default();
        (brief, history, focus)
    };

    let system = format!(
        "You are a warm, direct chess coach for an improving club player who wants to understand \
         the *why* behind moves. Explain ONE mistake from their own game.\n\n\
         Hard rules:\n\
         - Use ONLY the moves, lines and verified_facts provided. Never invent pieces, squares, \
           threats or tactics that are not stated there. If the facts are thin, say the problem is \
           positional and explain using the best line only.\n\
         - Use SAN notation exactly as given.\n\
         - Under 130 words, plain text, no headings or bullet lists.\n\n\
         Structure: (1) what went wrong in one or two sentences; (2) the idea behind the better move; \
         (3) end with a single line starting 'Rule:' giving a memorable habit. If their history shows \
         this tag is recurring, say so briefly (e.g. 'this is the 7th time...').\n\n\
         Tag meanings:\n{}",
        glossary_text()
    );
    let user = json!({
        "mistake": brief,
        "your_history_for_these_tags": history,
        "current_focus_weaknesses": focus,
    });
    let body = json!({
        "model": model,
        "max_tokens": 600,
        "system": system,
        "messages": [{ "role": "user", "content": user.to_string() }],
    });
    let resp = call_claude(api_key, body).await?;
    let text = resp["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return msg("empty response from Claude");
    }
    Store::open(store_path)?.save_explanation(mistake_id, text.trim(), model)?;
    Ok(text.trim().to_string())
}

fn insight_tool() -> Value {
    let tag_names: Vec<&str> = TAG_GLOSSARY.iter().map(|(k, _)| *k).collect();
    json!({
        "name": "report_insights",
        "description": "Report the player's recurring weaknesses and a training plan.",
        "input_schema": {
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
                            "title": { "type": "string", "description": "Short name, e.g. 'Loose pieces after quick moves'." },
                            "evidence": { "type": "string", "description": "Numbers and patterns from the data that show this." },
                            "rule_of_thumb": { "type": "string", "description": "One habit to build, phrased as an instruction." },
                            "mistake_ids": { "type": "array", "items": { "type": "integer" }, "description": "2-6 example mistake ids from the data." },
                            "drill_tags": { "type": "array", "items": { "type": "string", "enum": tag_names } },
                            "puzzle_themes": { "type": "array", "items": { "type": "string", "enum": PUZZLE_THEMES } },
                            "priority": { "type": "integer", "minimum": 1, "maximum": 3, "description": "1 = work on this first." }
                        }
                    }
                },
                "strengths": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
                "plan": { "type": "array", "items": { "type": "string" }, "minItems": 3, "maxItems": 6,
                          "description": "Concrete practice for the next week, e.g. '15 fork puzzles daily', 'blunder-check before every capture'." },
                "progress_note": { "type": "string", "description": "Compare with the previous analysis if given; otherwise say what to watch." }
            }
        }
    })
}

/// Cross-game pattern analysis. Saves and returns the raw JSON.
pub async fn analyze_patterns(api_key: &str, model: &str, store_path: &Path) -> TResult<String> {
    let (stats, examples, previous) = {
        let store = Store::open(store_path)?;
        let stats = store.stats()?;
        if stats.mistakes < 5 {
            return msg("Analyse a few more games first (need at least 5 mistakes).");
        }
        let sample = store.sample_for_insight(4, 10)?;
        let examples: Vec<Value> = sample
            .iter()
            .map(|m| mistake_brief(&store, m, true))
            .collect::<TResult<_>>()?;
        (stats, examples, store.latest_insight()?)
    };

    let system = format!(
        "You are an experienced chess coach analysing a club player's own games to personalise \
         their training. You get aggregate statistics over all analysed games and a sample of \
         representative mistakes with engine lines and verified facts.\n\n\
         Find the 2-4 recurring weaknesses that cost the most points, ranked by impact. Prefer \
         behavioural root causes (e.g. 'stops checking opponent threats after making a plan', \
         'plays too fast in winning positions') over restating tags. Support every claim with numbers \
         from the stats or ids of example mistakes. Do not invent tactics beyond the verified facts. \
         Choose drill_tags only from the tag list and puzzle_themes only from the allowed themes.\n\n\
         Tag meanings:\n{}",
        glossary_text()
    );
    let user = json!({
        "stats": stats,
        "example_mistakes": examples,
        "previous_analysis": previous,
    });
    let body = json!({
        "model": model,
        "max_tokens": 3000,
        "system": system,
        "tools": [insight_tool()],
        "tool_choice": { "type": "tool", "name": "report_insights" },
        "messages": [{ "role": "user", "content": user.to_string() }],
    });
    let resp = call_claude(api_key, body).await?;
    let input = resp["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "tool_use"))
        .map(|b| b["input"].clone())
        .ok_or_else(|| TrainingError::Msg("Claude did not return insights".into()))?;
    let json_str = serde_json::to_string(&input)?;
    Store::open(store_path)?.save_insight(stats.mistakes, &json_str)?;
    Ok(json_str)
}
