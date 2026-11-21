//! SQLite persistence for analysed games, mistakes, drill cards, AI explanations and insights.
//! Lives in its own file (`training.db` in the app data folder) so it never touches
//! your game databases.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use shakmaty::Color;

use super::{
    features::Detected, ingest::ParsedGame, CountRow, DrillCard, Insight, Mistake,
    MistakeFilter, MonthlyRate, TResult, TrainingStats, Weakness,
};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
    id            TEXT PRIMARY KEY,
    player_color  TEXT NOT NULL,
    white         TEXT,
    black         TEXT,
    white_elo     INTEGER,
    black_elo     INTEGER,
    result        TEXT,
    date          TEXT,
    time_control  TEXT,
    opening       TEXT,
    eco           TEXT,
    url           TEXT,
    plies         INTEGER,
    engine        TEXT,
    depth         INTEGER,
    analyzed_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mistakes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply              INTEGER NOT NULL,
    fen_before       TEXT NOT NULL,
    played_uci       TEXT NOT NULL,
    played_san       TEXT NOT NULL,
    best_uci         TEXT NOT NULL,
    best_san         TEXT NOT NULL,
    best_line        TEXT NOT NULL,
    best_line_uci    TEXT NOT NULL,
    refutation_line  TEXT NOT NULL,
    refutation_uci   TEXT NOT NULL,
    eval_before_cp   INTEGER NOT NULL,
    eval_after_cp    INTEGER NOT NULL,
    win_before       REAL NOT NULL,
    win_after        REAL NOT NULL,
    win_drop         REAL NOT NULL,
    severity         TEXT NOT NULL,
    phase            TEXT NOT NULL,
    moved_role       TEXT NOT NULL,
    clock_secs       REAL,
    time_spent_secs  REAL,
    created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mistakes_game ON mistakes(game_id);

CREATE TABLE IF NOT EXISTS mistake_tags (
    mistake_id INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (mistake_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON mistake_tags(tag);

CREATE TABLE IF NOT EXISTS cards (
    mistake_id INTEGER PRIMARY KEY REFERENCES mistakes(id) ON DELETE CASCADE,
    card_json  TEXT NOT NULL,
    due        TEXT NOT NULL,
    reviews    INTEGER NOT NULL DEFAULT 0,
    lapses     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS explanations (
    mistake_id INTEGER PRIMARY KEY REFERENCES mistakes(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT DEFAULT (datetime('now')),
    kind          TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS puzzle_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    puzzle_id  INTEGER NOT NULL,
    rating     INTEGER NOT NULL,
    themes     TEXT NOT NULL,
    weakness   TEXT,
    solved     INTEGER NOT NULL,
    hints      INTEGER NOT NULL,
    seconds    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_pid ON puzzle_attempts(puzzle_id);

CREATE TABLE IF NOT EXISTS maia_games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT DEFAULT (datetime('now')),
    game_id      TEXT NOT NULL,
    color        TEXT NOT NULL,
    elo          INTEGER NOT NULL,
    result       TEXT NOT NULL,
    plies        INTEGER NOT NULL,
    opening      TEXT,
    hints        INTEGER NOT NULL,
    takebacks    INTEGER NOT NULL,
    time_control TEXT
);

CREATE TABLE IF NOT EXISTS review_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    mistake_id INTEGER NOT NULL,
    lapse      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS endgame_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    drill_id   TEXT NOT NULL,
    success    INTEGER NOT NULL,
    clean      INTEGER NOT NULL,
    moves      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rep_lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    side       TEXT NOT NULL,
    name       TEXT NOT NULL,
    moves      TEXT NOT NULL,
    source     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rep_cards (
    side      TEXT NOT NULL,
    pos_key   TEXT NOT NULL,
    card_json TEXT NOT NULL,
    due       TEXT NOT NULL,
    PRIMARY KEY (side, pos_key)
);

CREATE TABLE IF NOT EXISTS rep_review_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    side       TEXT NOT NULL,
    pos_key    TEXT NOT NULL,
    lapse      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_marks (
    date       TEXT NOT NULL,
    mark       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (date, mark)
);

CREATE TABLE IF NOT EXISTS insights (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT DEFAULT (datetime('now')),
    mistakes_analyzed INTEGER NOT NULL,
    json              TEXT NOT NULL
);
"#;

pub struct GameRow {
    pub id: String,
    pub player_color: &'static str,
    pub white: Option<String>,
    pub black: Option<String>,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub result: Option<String>,
    pub date: Option<String>,
    pub time_control: Option<String>,
    pub opening: Option<String>,
    pub eco: Option<String>,
    pub url: Option<String>,
    pub plies: u32,
    pub engine: String,
    pub depth: u32,
    pub start_fen: Option<String>,
    pub moves_uci: String,
}

impl GameRow {
    pub fn from_parsed(g: &ParsedGame, color: Color, engine: &str, depth: u32) -> Self {
        let s = |k: &str| g.header(k).map(|v| v.to_string());
        // Chess.com puts the opening in ECOUrl (".../openings/Italian-Game-...").
        let opening = s("Opening").or_else(|| {
            g.header("ECOUrl")
                .and_then(|u| u.rsplit('/').next())
                .map(|slug| slug.replace('-', " "))
        });
        Self {
            id: g.id(),
            player_color: if color == Color::White { "white" } else { "black" },
            white: s("White"),
            black: s("Black"),
            white_elo: g.header("WhiteElo").and_then(|v| v.parse().ok()),
            black_elo: g.header("BlackElo").and_then(|v| v.parse().ok()),
            result: s("Result"),
            date: s("UTCDate").or_else(|| s("Date")).map(|d| d.replace('.', "-")),
            time_control: s("TimeControl"),
            opening,
            eco: s("ECO"),
            url: s("Link").or_else(|| s("Site").filter(|v| v.starts_with("http"))),
            plies: g.moves_uci.len() as u32,
            engine: std::path::Path::new(engine)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default(),
            depth,
            start_fen: g.start_fen.clone(),
            moves_uci: g.moves_uci.join(" "),
        }
    }
}

pub struct NewMistake {
    pub ply: u32,
    pub fen_before: String,
    pub clock_secs: Option<f32>,
    pub detected: Detected,
    pub best_line_uci: Vec<String>,
    pub refutation_uci: Vec<String>,
    /// Engine's second-best move and its eval (mover's POV).
    pub second: Option<(String, i32)>,
}

/// Broad time-control bucket, so stats group "180+2" and "180" together as blitz.
pub fn tc_bucket(tc: Option<&str>) -> String {
    let Some(tc) = tc else { return "unknown".into() };
    if tc.contains('/') {
        return "daily".into();
    }
    let mut it = tc.split('+');
    let base: f32 = it.next().and_then(|b| b.parse().ok()).unwrap_or(0.0);
    let inc: f32 = it.next().and_then(|i| i.parse().ok()).unwrap_or(0.0);
    let est = base + 40.0 * inc;
    match est {
        e if e < 180.0 => "bullet",
        e if e < 480.0 => "blitz",
        e if e < 1500.0 => "rapid",
        _ => "classical",
    }
    .into()
}

/// Add columns introduced after the first release (Drills v2).
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has = |table: &str, col: &str| -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        for n in names {
            if n? == col {
                return Ok(true);
            }
        }
        Ok(false)
    };
    for (table, col, ty) in [
        ("games", "start_fen", "TEXT"),
        ("games", "moves_uci", "TEXT"),
        ("mistakes", "second_uci", "TEXT"),
        ("mistakes", "second_cp", "INTEGER"),
    ] {
        if !has(table, col)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {ty}"))?;
        }
    }
    Ok(())
}

pub struct Store {
    conn: Connection,
}

const MISTAKE_SELECT: &str = r#"
SELECT m.id, m.game_id, m.ply, m.fen_before, g.player_color, m.played_uci, m.played_san,
       m.best_uci, m.best_san, m.best_line, m.refutation_line, m.eval_before_cp, m.eval_after_cp,
       m.win_before, m.win_after, m.win_drop, m.severity, m.phase, m.moved_role,
       m.clock_secs, m.time_spent_secs,
       CASE WHEN g.player_color = 'white' THEN g.black ELSE g.white END,
       g.opening, g.time_control, g.date, g.url,
       (SELECT group_concat(tag, ',') FROM mistake_tags t WHERE t.mistake_id = m.id),
       m.second_uci, m.second_cp
FROM mistakes m JOIN games g ON g.id = m.game_id
"#;

fn row_to_mistake(r: &rusqlite::Row) -> rusqlite::Result<Mistake> {
    let tags: Option<String> = r.get(26)?;
    Ok(Mistake {
        id: r.get(0)?,
        game_id: r.get(1)?,
        ply: r.get(2)?,
        fen_before: r.get(3)?,
        player_color: r.get(4)?,
        played_uci: r.get(5)?,
        played_san: r.get(6)?,
        best_uci: r.get(7)?,
        best_san: r.get(8)?,
        best_line: r.get(9)?,
        refutation_line: r.get(10)?,
        eval_before_cp: r.get(11)?,
        eval_after_cp: r.get(12)?,
        win_before: r.get::<_, f64>(13)? as f32,
        win_after: r.get::<_, f64>(14)? as f32,
        win_drop: r.get::<_, f64>(15)? as f32,
        severity: r.get(16)?,
        phase: r.get(17)?,
        moved_role: r.get(18)?,
        clock_secs: r.get::<_, Option<f64>>(19)?.map(|v| v as f32),
        time_spent_secs: r.get::<_, Option<f64>>(20)?.map(|v| v as f32),
        opponent: r.get::<_, Option<String>>(21)?.unwrap_or_default(),
        opening: r.get(22)?,
        time_control: r.get(23)?,
        date: r.get(24)?,
        url: r.get(25)?,
        tags: tags
            .map(|t| t.split(',').map(|s| s.to_string()).collect())
            .unwrap_or_default(),
        second_uci: r.get(27)?,
        second_cp: r.get(28)?,
    })
}

impl Store {
    pub fn open(path: &Path) -> TResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> TResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn has_game(&self, id: &str) -> TResult<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM games WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn insert_game_with_mistakes(&self, g: &GameRow, mistakes: &[NewMistake]) -> TResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO games (id, player_color, white, black, white_elo, black_elo, result,
                date, time_control, opening, eco, url, plies, engine, depth, start_fen, moves_uci)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                g.id, g.player_color, g.white, g.black, g.white_elo, g.black_elo, g.result, g.date,
                g.time_control, g.opening, g.eco, g.url, g.plies, g.engine, g.depth, g.start_fen,
                g.moves_uci
            ],
        )?;
        for m in mistakes {
            let d = &m.detected;
            tx.execute(
                "INSERT INTO mistakes (game_id, ply, fen_before, played_uci, played_san, best_uci,
                    best_san, best_line, best_line_uci, refutation_line, refutation_uci,
                    eval_before_cp, eval_after_cp, win_before, win_after, win_drop, severity, phase,
                    moved_role, clock_secs, time_spent_secs, second_uci, second_cp)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
                params![
                    g.id,
                    m.ply,
                    m.fen_before,
                    d.played_uci,
                    d.played_san,
                    d.best_uci,
                    d.best_san,
                    d.best_line_san,
                    m.best_line_uci.join(" "),
                    d.refutation_san,
                    m.refutation_uci.join(" "),
                    d.eval_before_cp,
                    d.eval_after_cp,
                    d.win_before as f64,
                    d.win_after as f64,
                    d.win_drop as f64,
                    d.severity,
                    d.phase,
                    d.moved_role,
                    m.clock_secs.map(|v| v as f64),
                    d.time_spent_secs.map(|v| v as f64),
                    m.second.as_ref().map(|x| x.0.clone()),
                    m.second.as_ref().map(|x| x.1),
                ],
            )?;
            let id = tx.last_insert_rowid();
            for t in &d.tags {
                tx.execute(
                    "INSERT OR IGNORE INTO mistake_tags (mistake_id, tag) VALUES (?1, ?2)",
                    params![id, t],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Fill in moves for games analysed before Drills v2 (no engine work needed).
    pub fn backfill_game_moves(&self, id: &str, start_fen: Option<&str>, moves_uci: &str) -> TResult<()> {
        self.conn.execute(
            "UPDATE games SET start_fen = ?2, moves_uci = ?3 WHERE id = ?1 AND moves_uci IS NULL",
            params![id, start_fen, moves_uci],
        )?;
        Ok(())
    }

    pub fn mistake_context(&self, mistake_id: i64) -> TResult<super::MistakeContext> {
        let row: Option<(u32, Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT m.ply, g.start_fen, g.moves_uci FROM mistakes m JOIN games g ON g.id = m.game_id
                 WHERE m.id = ?1",
                [mistake_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((ply, start_fen, Some(moves))) = row else {
            return Ok(Default::default());
        };
        let moves: Vec<String> = moves.split_whitespace().map(|s| s.to_string()).collect();
        Ok(super::features::game_context(start_fen.as_deref(), &moves, ply as usize))
    }

    pub fn get_mistake(&self, id: i64) -> TResult<Option<Mistake>> {
        let sql = format!("{MISTAKE_SELECT} WHERE m.id = ?1");
        Ok(self.conn.query_row(&sql, [id], row_to_mistake).optional()?)
    }

    /// UCI lines (best line, refutation) for verified-fact generation.
    pub fn get_mistake_lines(&self, id: i64) -> TResult<(Vec<String>, Vec<String>)> {
        let (a, b): (String, String) = self.conn.query_row(
            "SELECT best_line_uci, refutation_uci FROM mistakes WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let split = |s: String| s.split_whitespace().map(|x| x.to_string()).collect();
        Ok((split(a), split(b)))
    }

    pub fn list_mistakes(&self, f: &MistakeFilter) -> TResult<Vec<Mistake>> {
        let sql = format!(
            "{MISTAKE_SELECT}
             WHERE (?1 IS NULL OR EXISTS (SELECT 1 FROM mistake_tags t WHERE t.mistake_id = m.id AND t.tag = ?1))
               AND (?2 IS NULL OR m.phase = ?2)
               AND (?3 IS NULL OR m.severity = ?3)
             ORDER BY g.date DESC, m.ply ASC
             LIMIT ?4"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![f.tag, f.phase, f.severity, f.limit.unwrap_or(200)],
            row_to_mistake,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn counts(&self, sql: &str) -> TResult<Vec<CountRow>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(CountRow {
                key: r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "unknown".into()),
                count: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn stats(&self) -> TResult<TrainingStats> {
        let games: u32 = self.conn.query_row("SELECT count(*) FROM games", [], |r| r.get(0))?;
        let mistakes: u32 = self.conn.query_row(
            "SELECT count(*) FROM mistakes WHERE severity != 'inaccuracy'",
            [],
            |r| r.get(0),
        )?;
        let blunders: u32 = self.conn.query_row(
            "SELECT count(*) FROM mistakes WHERE severity = 'blunder'",
            [],
            |r| r.get(0),
        )?;
        const SERIOUS: &str = "m.severity != 'inaccuracy'";
        let by_tag = self.counts(&format!(
            "SELECT t.tag, count(*) c FROM mistake_tags t JOIN mistakes m ON m.id = t.mistake_id
             WHERE {SERIOUS} GROUP BY t.tag ORDER BY c DESC"
        ))?;
        let by_phase = self.counts(&format!(
            "SELECT m.phase, count(*) c FROM mistakes m WHERE {SERIOUS} GROUP BY m.phase ORDER BY c DESC"
        ))?;
        let by_piece = self.counts(&format!(
            "SELECT m.moved_role, count(*) c FROM mistakes m WHERE {SERIOUS} GROUP BY m.moved_role ORDER BY c DESC"
        ))?;
        let by_opening = self.counts(&format!(
            "SELECT g.opening, count(*) c FROM mistakes m JOIN games g ON g.id = m.game_id
             WHERE {SERIOUS} GROUP BY g.opening ORDER BY c DESC LIMIT 10"
        ))?;

        // Time-control buckets need Rust-side grouping.
        let mut tc_map: std::collections::BTreeMap<String, u32> = Default::default();
        {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT g.time_control FROM mistakes m JOIN games g ON g.id = m.game_id WHERE {SERIOUS}"
            ))?;
            let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
            for tc in rows {
                *tc_map.entry(tc_bucket(tc?.as_deref())).or_default() += 1;
            }
        }
        let mut by_time_control: Vec<CountRow> = tc_map
            .into_iter()
            .map(|(key, count)| CountRow { key, count })
            .collect();
        by_time_control.sort_by(|a, b| b.count.cmp(&a.count));

        let monthly_rate = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT substr(g.date, 1, 7) mo, count(DISTINCT g.id),
                        (SELECT count(*) FROM mistakes m JOIN games g2 ON g2.id = m.game_id
                          WHERE substr(g2.date,1,7) = substr(g.date,1,7) AND {SERIOUS})
                 FROM games g WHERE g.date IS NOT NULL GROUP BY mo ORDER BY mo"
            ))?;
            let rows = stmt.query_map([], |r| {
                let games: u32 = r.get(1)?;
                let m: u32 = r.get(2)?;
                Ok(MonthlyRate {
                    month: r.get(0)?,
                    games,
                    mistakes_per_game: if games > 0 { m as f32 / games as f32 } else { 0.0 },
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let cards_total: u32 = self.conn.query_row("SELECT count(*) FROM cards", [], |r| r.get(0))?;
        let cards_due: u32 = self.conn.query_row(
            "SELECT count(*) FROM cards WHERE due <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            [],
            |r| r.get(0),
        )?;

        Ok(TrainingStats {
            games,
            mistakes,
            blunders,
            mistakes_per_game: if games > 0 { mistakes as f32 / games as f32 } else { 0.0 },
            by_tag,
            by_phase,
            by_opening,
            by_time_control,
            by_piece,
            monthly_rate,
            cards_due,
            cards_total,
        })
    }

    /// Drill queue: due cards first, then new cards from your mistakes/blunders.
    /// Anything matching `focus_tags` (the coach's current weaknesses) jumps the queue.
    pub fn drill_queue(
        &self,
        focus_tags: &[String],
        limit: u32,
        new_limit: u32,
    ) -> TResult<Vec<DrillCard>> {
        let focus_json = serde_json::to_string(focus_tags)?;
        let focus_sql = "EXISTS (SELECT 1 FROM mistake_tags t, json_each(?1) j
                                 WHERE t.mistake_id = m.id AND t.tag = j.value)";
        let mut out = Vec::new();

        let due_sql = format!(
            "{MISTAKE_SELECT} JOIN cards c ON c.mistake_id = m.id
             WHERE c.due <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
             ORDER BY {focus_sql} DESC, c.due ASC LIMIT ?2"
        );
        let mut stmt = self.conn.prepare(&due_sql)?;
        let rows = stmt.query_map(params![focus_json, limit], row_to_mistake)?;
        let due: Vec<Mistake> = rows.collect::<Result<_, _>>()?;
        for m in due {
            let card: Option<String> = self
                .conn
                .query_row("SELECT card_json FROM cards WHERE mistake_id = ?1", [m.id], |r| r.get(0))
                .optional()?;
            let focus = m.tags.iter().any(|t| focus_tags.contains(t));
            out.push(DrillCard { mistake: m, card_json: card, focus });
        }

        let remaining = limit.saturating_sub(out.len() as u32).min(new_limit);
        if remaining > 0 {
            let new_sql = format!(
                "{MISTAKE_SELECT}
                 WHERE m.severity != 'inaccuracy'
                   AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.mistake_id = m.id)
                 ORDER BY {focus_sql} DESC, m.win_drop DESC
                 LIMIT ?2"
            );
            let mut stmt = self.conn.prepare(&new_sql)?;
            let rows = stmt.query_map(params![focus_json, remaining], row_to_mistake)?;
            for m in rows {
                let m = m?;
                let focus = m.tags.iter().any(|t| focus_tags.contains(t));
                out.push(DrillCard { mistake: m, card_json: None, focus });
            }
        }
        Ok(out)
    }

    pub fn save_card(&self, mistake_id: i64, card_json: &str, due_iso: &str, lapse: bool) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO cards (mistake_id, card_json, due, reviews, lapses) VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(mistake_id) DO UPDATE SET card_json = ?2, due = ?3,
                reviews = reviews + 1, lapses = lapses + ?4",
            params![mistake_id, card_json, due_iso, lapse as i32],
        )?;
        self.conn.execute(
            "INSERT INTO review_log (mistake_id, lapse) VALUES (?1, ?2)",
            params![mistake_id, lapse as i32],
        )?;
        Ok(())
    }

    pub fn get_explanation(&self, mistake_id: i64) -> TResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT text FROM explanations WHERE mistake_id = ?1",
                [mistake_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn save_explanation(&self, mistake_id: i64, text: &str, model: &str) -> TResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO explanations (mistake_id, text, model) VALUES (?1, ?2, ?3)",
            params![mistake_id, text, model],
        )?;
        Ok(())
    }

    /// How many mistakes of each of these tags you have made in total (for "this is the
    /// 9th time..." style personalisation).
    pub fn tag_counts(&self, tags: &[String]) -> TResult<Vec<CountRow>> {
        let mut out = Vec::new();
        for t in tags {
            let c: u32 = self.conn.query_row(
                "SELECT count(*) FROM mistake_tags t JOIN mistakes m ON m.id = t.mistake_id
                 WHERE t.tag = ?1 AND m.severity != 'inaccuracy'",
                [t],
                |r| r.get(0),
            )?;
            out.push(CountRow { key: t.clone(), count: c });
        }
        Ok(out)
    }

    /// Representative serious mistakes for the pattern analysis: the most costly ones
    /// from each common tag, plus the most recent ones. Returns (mistake, verified facts input).
    pub fn sample_for_insight(&self, per_tag: u32, recent: u32) -> TResult<Vec<Mistake>> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let stats = self.stats()?;
        for row in stats.by_tag.iter().take(8) {
            for m in self.list_mistakes(&MistakeFilter {
                tag: Some(row.key.clone()),
                phase: None,
                severity: None,
                limit: Some(200),
            })? {
                if m.severity == "inaccuracy" || !seen.insert(m.id) {
                    continue;
                }
                out.push(m);
                if out.iter().filter(|x| x.tags.contains(&row.key)).count() as u32 >= per_tag {
                    break;
                }
            }
        }
        for m in self.list_mistakes(&MistakeFilter { limit: Some(recent * 2), ..Default::default() })? {
            if m.severity != "inaccuracy" && seen.insert(m.id) {
                out.push(m);
                if seen.len() as u32 >= per_tag * 8 + recent {
                    break;
                }
            }
        }
        Ok(out)
    }

    pub fn serious_mistake_count(&self) -> TResult<u32> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM mistakes WHERE severity != 'inaccuracy'",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn save_insight(&self, mistakes_analyzed: u32, json: &str) -> TResult<i64> {
        self.conn.execute(
            "INSERT INTO insights (mistakes_analyzed, json) VALUES (?1, ?2)",
            params![mistakes_analyzed, json],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn latest_insight(&self) -> TResult<Option<Insight>> {
        let row: Option<(i64, String, u32, String)> = self
            .conn
            .query_row(
                "SELECT id, created_at, mistakes_analyzed, json FROM insights ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((id, created_at, n, json)) = row else { return Ok(None) };
        let v: serde_json::Value = serde_json::from_str(&json)?;
        let get_str = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let get_list = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default()
        };
        let weaknesses: Vec<Weakness> = v
            .get("weaknesses")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        Ok(Some(Insight {
            id,
            created_at,
            mistakes_analyzed: n,
            summary: get_str("summary"),
            weaknesses,
            strengths: get_list("strengths"),
            plan: get_list("plan"),
            progress_note: get_str("progress_note"),
        }))
    }

    pub fn log_usage(
        &self,
        kind: &str,
        provider: &str,
        model: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO ai_usage (kind, provider, model, input_tokens, output_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kind, provider, model, input_tokens as i64, output_tokens as i64],
        )?;
        Ok(())
    }

    pub fn usage_last_days(&self, days: u32) -> TResult<super::UsageSummary> {
        Ok(self.conn.query_row(
            "SELECT count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0)
             FROM ai_usage WHERE created_at >= datetime('now', ?1)",
            [format!("-{days} days")],
            |r| {
                Ok(super::UsageSummary {
                    calls: r.get(0)?,
                    input_tokens: r.get::<_, i64>(1)? as u32,
                    output_tokens: r.get::<_, i64>(2)? as u32,
                })
            },
        )?)
    }

    pub fn record_puzzle_attempt(&self, a: &super::PuzzleAttempt) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO puzzle_attempts (puzzle_id, rating, themes, weakness, solved, hints, seconds)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                a.puzzle_id,
                a.rating,
                a.themes.join(","),
                a.weakness,
                a.solved as i32,
                a.hints,
                a.seconds as f64
            ],
        )?;
        Ok(())
    }

    pub fn attempted_puzzle_ids(&self) -> TResult<std::collections::HashSet<i64>> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT puzzle_id FROM puzzle_attempts")?;
        let ids = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Your typical game rating (average of your last 20 analysed games), if known.
    pub fn player_game_rating(&self) -> TResult<Option<i32>> {
        let avg: Option<f64> = self.conn.query_row(
            "SELECT avg(r) FROM (
                SELECT CASE WHEN player_color = 'white' THEN white_elo ELSE black_elo END AS r
                FROM games WHERE r IS NOT NULL ORDER BY date DESC LIMIT 20)",
            [],
            |r| r.get(0),
        )?;
        Ok(avg.map(|a| a.round() as i32))
    }

    /// Coach puzzle rating: Elo replayed over all attempts (K=40 for the first 20, then 24).
    /// Starts from your game rating + 200 (Lichess puzzle ratings run higher), or 1500.
    pub fn puzzle_profile(&self) -> TResult<super::PuzzleProfile> {
        let start = self
            .player_game_rating()?
            .map(|r| (r + 200).clamp(800, 2800))
            .unwrap_or(1500);
        let mut rating = start as f64;
        let mut attempts = 0u32;
        let mut solved_total = 0u32;
        {
            let mut stmt =
                self.conn.prepare("SELECT rating, solved FROM puzzle_attempts ORDER BY id")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i32>(0)?, r.get::<_, i32>(1)? != 0)))?;
            for row in rows {
                let (pr, solved) = row?;
                let expected = 1.0 / (1.0 + 10f64.powf((pr as f64 - rating) / 400.0));
                let k = if attempts < 20 { 40.0 } else { 24.0 };
                rating += k * (if solved { 1.0 } else { 0.0 } - expected);
                attempts += 1;
                solved_total += solved as u32;
            }
        }

        let mut by_theme: std::collections::BTreeMap<String, super::ThemeStat> = Default::default();
        let mut stmt = self.conn.prepare(
            "SELECT themes, solved, created_at >= datetime('now', '-7 days') FROM puzzle_attempts",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)? != 0, r.get::<_, i32>(2)? != 0))
        })?;
        for row in rows {
            let (themes, solved, recent) = row?;
            for t in themes.split(',').filter(|t| !t.is_empty()) {
                let e = by_theme.entry(t.to_string()).or_insert_with(|| super::ThemeStat {
                    theme: t.to_string(),
                    ..Default::default()
                });
                e.attempts += 1;
                e.solved += solved as u32;
                if recent {
                    e.recent_attempts += 1;
                    e.recent_solved += solved as u32;
                }
            }
        }
        let mut theme_stats: Vec<super::ThemeStat> = by_theme.into_values().collect();
        theme_stats.sort_by(|a, b| b.attempts.cmp(&a.attempts));
        Ok(super::PuzzleProfile {
            rating: rating.round() as i32,
            attempts,
            solved: solved_total,
            theme_stats,
        })
    }

    pub fn record_maia_game(&self, g: &super::MaiaGameRecord) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO maia_games (game_id, color, elo, result, plies, opening, hints, takebacks, time_control)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                g.game_id, g.color, g.elo, g.result, g.plies, g.opening, g.hints, g.takebacks,
                g.time_control
            ],
        )?;
        Ok(())
    }

    pub fn maia_summary(&self) -> TResult<super::MaiaSummary> {
        let mut s = super::MaiaSummary::default();
        let rows: Vec<(String, String, i32, String, Option<String>, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT created_at, color, elo, result, opening, game_id FROM maia_games ORDER BY id",
            )?;
            let it = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?;
            it.collect::<Result<_, _>>()?
        };
        let score = |res: &str| match res {
            "win" => 1.0f32,
            "draw" => 0.5,
            _ => 0.0,
        };
        let mut levels: std::collections::BTreeMap<i32, super::MaiaLevelRow> = Default::default();
        let mut openings: std::collections::HashMap<(String, String), (u32, f32)> = Default::default();
        for (_, color, elo, result, opening, _) in &rows {
            s.games += 1;
            let l = levels.entry(*elo).or_insert_with(|| super::MaiaLevelRow { elo: *elo, ..Default::default() });
            l.games += 1;
            match result.as_str() {
                "win" => {
                    s.wins += 1;
                    l.wins += 1
                }
                "draw" => {
                    s.draws += 1;
                    l.draws += 1
                }
                _ => {
                    s.losses += 1;
                    l.losses += 1
                }
            }
            if let Some(o) = opening.as_ref().filter(|o| !o.is_empty()) {
                let e = openings.entry((o.clone(), color.clone())).or_default();
                e.0 += 1;
                e.1 += score(result);
            }
        }
        s.by_level = levels.into_values().collect();
        let mut ops: Vec<super::OpeningRow> = openings
            .into_iter()
            .map(|((name, color), (games, pts))| super::OpeningRow {
                name,
                color,
                games,
                score: (pts / games as f32 * 100.0).round() as u32,
            })
            .collect();
        ops.sort_by(|a, b| b.games.cmp(&a.games).then(a.name.cmp(&b.name)));
        ops.truncate(12);
        s.openings = ops;
        s.recent = rows
            .iter()
            .rev()
            .take(10)
            .map(|(date, color, elo, result, opening, game_id)| super::MaiaRecent {
                date: date.clone(),
                color: color.clone(),
                elo: *elo,
                result: result.clone(),
                opening: opening.clone(),
                game_id: game_id.clone(),
            })
            .collect();
        s.suggested_elo = match rows.last() {
            None => super::maia::suggested_start_elo(self.player_game_rating()?),
            Some((_, _, last_elo, ..)) => {
                let at_level: Vec<f32> = rows
                    .iter()
                    .filter(|r| r.2 == *last_elo)
                    .map(|r| score(&r.3))
                    .collect();
                super::maia::next_elo(*last_elo, &at_level)
            }
        };
        Ok(s)
    }

    /// SQLite modifier that shifts UTC timestamps to the user's local time.
    fn tz(offset_minutes: i32) -> String {
        format!("{offset_minutes:+} minutes")
    }

    pub fn local_today(&self, tz_offset_minutes: i32) -> TResult<String> {
        Ok(self.conn.query_row(
            "SELECT date('now', ?1)",
            [Self::tz(tz_offset_minutes)],
            |r| r.get(0),
        )?)
    }

    fn count_on(&self, sql_where_table: &str, tz: &str, date: &str) -> TResult<u32> {
        Ok(self.conn.query_row(
            &format!("SELECT count(*) FROM {sql_where_table} AND date(created_at, ?1) = ?2"),
            params![tz, date],
            |r| r.get(0),
        )?)
    }

    pub fn today_counts(&self, tz_offset_minutes: i32) -> TResult<super::TodayCounts> {
        let tz = Self::tz(tz_offset_minutes);
        let date = self.local_today(tz_offset_minutes)?;
        let marks = {
            let mut stmt = self.conn.prepare("SELECT mark FROM lesson_marks WHERE date = ?1 ORDER BY mark")?;
            let it = stmt.query_map([&date], |r| r.get::<_, String>(0))?;
            it.collect::<Result<Vec<_>, _>>()?
        };
        let games_analyzed: u32 = self.conn.query_row(
            "SELECT count(*) FROM games WHERE date(analyzed_at, ?1) = ?2",
            params![tz, date],
            |r| r.get(0),
        )?;
        let latest_insight_date: Option<String> = self
            .conn
            .query_row(
                "SELECT date(created_at, ?1) FROM insights ORDER BY id DESC LIMIT 1",
                [&tz],
                |r| r.get(0),
            )
            .optional()?;
        Ok(super::TodayCounts {
            drills_reviewed: self.count_on("review_log WHERE 1=1", &tz, &date)?,
            warmup_puzzles: self.count_on("puzzle_attempts WHERE weakness = 'Warm-up'", &tz, &date)?,
            focus_puzzles: self.count_on(
                "puzzle_attempts WHERE (weakness IS NULL OR weakness != 'Warm-up')",
                &tz,
                &date,
            )?,
            maia_games: self.count_on("maia_games WHERE 1=1", &tz, &date)?,
            opening_reviews: self.count_on("rep_review_log WHERE 1=1", &tz, &date)?,
            games_analyzed,
            insight_today: latest_insight_date.as_deref() == Some(date.as_str()),
            latest_insight_date,
            marks,
            date,
        })
    }

    pub fn set_mark(&self, date: &str, mark: &str, on: bool) -> TResult<()> {
        if on {
            self.conn.execute(
                "INSERT OR IGNORE INTO lesson_marks (date, mark) VALUES (?1, ?2)",
                params![date, mark],
            )?;
        } else {
            self.conn.execute(
                "DELETE FROM lesson_marks WHERE date = ?1 AND mark = ?2",
                params![date, mark],
            )?;
        }
        Ok(())
    }

    /// Activity for each of the last `days` local dates (oldest first), for the week strip and streak.
    pub fn history(&self, days: u32, tz_offset_minutes: i32) -> TResult<Vec<super::DayActivity>> {
        let tz = Self::tz(tz_offset_minutes);
        let today = self.local_today(tz_offset_minutes)?;
        let mut out = Vec::new();
        for back in (0..days).rev() {
            let date: String = self.conn.query_row(
                "SELECT date(?1, ?2)",
                params![today, format!("-{back} days")],
                |r| r.get(0),
            )?;
            let lesson_complete: bool = self.conn.query_row(
                "SELECT count(*) > 0 FROM lesson_marks WHERE date = ?1 AND mark = 'lesson_complete'",
                [&date],
                |r| r.get(0),
            )?;
            out.push(super::DayActivity {
                drills: self.count_on("review_log WHERE 1=1", &tz, &date)?,
                puzzles: self.count_on("puzzle_attempts WHERE 1=1", &tz, &date)?,
                games: self.count_on("maia_games WHERE 1=1", &tz, &date)?,
                lesson_complete,
                date,
            });
        }
        Ok(out)
    }

    // ---------- opening repertoire ----------

    pub fn rep_lines(&self) -> TResult<Vec<super::RepLine>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, side, name, moves, source FROM rep_lines ORDER BY side DESC, id")?;
        let rows = stmt.query_map([], |r| {
            Ok(super::RepLine {
                id: r.get(0)?,
                side: r.get(1)?,
                name: r.get(2)?,
                moves: r.get(3)?,
                source: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Insert (id = None) or update a line; returns its id.
    pub fn rep_save_line(&self, l: &super::RepLine) -> TResult<i64> {
        match l.id {
            Some(id) => {
                self.conn.execute(
                    "UPDATE rep_lines SET side = ?2, name = ?3, moves = ?4, source = ?5 WHERE id = ?1",
                    params![id, l.side, l.name, l.moves, l.source],
                )?;
                Ok(id)
            }
            None => {
                self.conn.execute(
                    "INSERT INTO rep_lines (side, name, moves, source) VALUES (?1, ?2, ?3, ?4)",
                    params![l.side, l.name, l.moves, l.source],
                )?;
                Ok(self.conn.last_insert_rowid())
            }
        }
    }

    pub fn rep_delete_line(&self, id: i64) -> TResult<()> {
        self.conn.execute("DELETE FROM rep_lines WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn rep_cards(&self) -> TResult<Vec<super::RepCard>> {
        let mut stmt = self.conn.prepare("SELECT side, pos_key, card_json, due FROM rep_cards")?;
        let rows = stmt.query_map([], |r| {
            Ok(super::RepCard { side: r.get(0)?, pos_key: r.get(1)?, card_json: r.get(2)?, due: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Save a card's schedule; `log` = this was a review (counts toward today's lesson).
    pub fn rep_save_card(&self, c: &super::RepCard, log: Option<bool>) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO rep_cards (side, pos_key, card_json, due) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(side, pos_key) DO UPDATE SET card_json = excluded.card_json, due = excluded.due",
            params![c.side, c.pos_key, c.card_json, c.due],
        )?;
        if let Some(lapse) = log {
            self.conn.execute(
                "INSERT INTO rep_review_log (side, pos_key, lapse) VALUES (?1, ?2, ?3)",
                params![c.side, c.pos_key, lapse],
            )?;
        }
        Ok(())
    }

    /// Your most recent analysed games from the standard start, for repertoire coverage.
    pub fn rep_games(&self, limit: u32) -> TResult<Vec<super::RepGame>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, player_color, moves_uci, date,
                    CASE WHEN player_color = 'white' THEN black ELSE white END, url
             FROM games WHERE moves_uci IS NOT NULL AND moves_uci != '' AND (start_fen IS NULL OR start_fen LIKE 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w%')
             ORDER BY date DESC, analyzed_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(super::RepGame {
                game_id: r.get(0)?,
                color: r.get(1)?,
                moves_uci: r.get(2)?,
                date: r.get(3)?,
                opponent: r.get(4)?,
                url: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn record_endgame(&self, a: &super::EndgameAttempt) -> TResult<()> {
        self.conn.execute(
            "INSERT INTO endgame_attempts (drill_id, success, clean, moves) VALUES (?1, ?2, ?3, ?4)",
            params![a.drill_id, a.success, a.clean, a.moves],
        )?;
        Ok(())
    }

    /// Per-drill totals. `clean_days` = distinct local days with a clean success (mastery stars).
    pub fn endgame_stats(&self, tz_offset_minutes: i32) -> TResult<Vec<super::EndgameStat>> {
        let tz = Self::tz(tz_offset_minutes);
        let mut stmt = self.conn.prepare(
            "SELECT drill_id, count(*), sum(success),
                    count(DISTINCT CASE WHEN success AND clean THEN date(created_at, ?1) END),
                    max(date(created_at, ?1))
             FROM endgame_attempts GROUP BY drill_id ORDER BY drill_id",
        )?;
        let rows = stmt.query_map([&tz], |r| {
            Ok(super::EndgameStat {
                drill_id: r.get(0)?,
                attempts: r.get(1)?,
                successes: r.get::<_, Option<u32>>(2)?.unwrap_or(0),
                clean_days: r.get(3)?,
                last_date: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The costliest mistake from games analysed today: what the "Look back" step reviews.
    pub fn lookback_mistake(&self, tz_offset_minutes: i32) -> TResult<Option<super::Mistake>> {
        let tz = Self::tz(tz_offset_minutes);
        let today = self.local_today(tz_offset_minutes)?;
        let sql = format!(
            "{MISTAKE_SELECT} WHERE date(g.analyzed_at, ?1) = ?2 AND m.severity != 'inaccuracy'
             ORDER BY m.win_drop DESC LIMIT 1"
        );
        Ok(self.conn.query_row(&sql, params![tz, today], row_to_mistake).optional()?)
    }

    pub fn focus_tags(&self) -> TResult<Vec<String>> {
        Ok(self
            .latest_insight()?
            .map(|i| {
                let mut v: Vec<String> =
                    i.weaknesses.into_iter().flat_map(|w| w.drill_tags).collect();
                v.sort();
                v.dedup();
                v
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::training::ingest::parse_pgn_str;

    #[test]
    fn repertoire_lines_cards_and_log() {
        let store = Store::open_in_memory().unwrap();
        let mut line = crate::training::RepLine {
            id: None,
            side: "white".into(),
            name: "London".into(),
            moves: "d2d4 d7d5 c1f4".into(),
            source: "starter".into(),
        };
        let id = store.rep_save_line(&line).unwrap();
        line.id = Some(id);
        line.name = "London main".into();
        store.rep_save_line(&line).unwrap();
        let lines = store.rep_lines().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].name, "London main");
        let card = crate::training::RepCard {
            side: "white".into(),
            pos_key: "k".into(),
            card_json: "{}".into(),
            due: "2026-01-01T00:00:00Z".into(),
        };
        store.rep_save_card(&card, Some(false)).unwrap();
        store.rep_save_card(&crate::training::RepCard { due: "2027-01-01T00:00:00Z".into(), ..card.clone() }, None).unwrap();
        let cards = store.rep_cards().unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].due, "2027-01-01T00:00:00Z");
        assert_eq!(store.today_counts(0).unwrap().opening_reviews, 1);
        store.rep_delete_line(id).unwrap();
        assert!(store.rep_lines().unwrap().is_empty());
        assert!(store.rep_games(10).unwrap().is_empty());
    }

    #[test]
    fn endgame_stats_count_clean_days() {
        let store = Store::open_in_memory().unwrap();
        let rec = |id: &str, success, clean| {
            store
                .record_endgame(&crate::training::EndgameAttempt { drill_id: id.into(), success, clean, moves: 9 })
                .unwrap()
        };
        rec("queen", true, true);
        rec("queen", true, true);
        rec("queen", false, false);
        rec("rook", true, false);
        let st = store.endgame_stats(0).unwrap();
        assert_eq!(st.len(), 2);
        let q = st.iter().find(|s| s.drill_id == "queen").unwrap();
        assert_eq!((q.attempts, q.successes, q.clean_days), (3, 2, 1));
        let r = st.iter().find(|s| s.drill_id == "rook").unwrap();
        assert_eq!((r.successes, r.clean_days), (1, 0));
    }
    use crate::training::features::*;

    #[test]
    fn puzzle_attempts_update_rating_and_theme_stats() {
        let store = Store::open_in_memory().unwrap();
        let p0 = store.puzzle_profile().unwrap();
        assert_eq!(p0.rating, 1500, "no games -> default start");
        let attempt = |solved: bool, themes: &[&str]| crate::training::PuzzleAttempt {
            puzzle_id: 7,
            rating: 1500,
            themes: themes.iter().map(|s| s.to_string()).collect(),
            weakness: Some("Loose pieces".into()),
            solved,
            hints: 0,
            seconds: 12.0,
        };
        store.record_puzzle_attempt(&attempt(true, &["fork", "middlegame"])).unwrap();
        store.record_puzzle_attempt(&attempt(true, &["fork"])).unwrap();
        store.record_puzzle_attempt(&attempt(false, &["hangingPiece"])).unwrap();
        let p = store.puzzle_profile().unwrap();
        assert_eq!(p.attempts, 3);
        assert_eq!(p.solved, 2);
        assert!(p.rating > 1500, "two wins vs one loss at equal rating raises rating: {}", p.rating);
        let fork = p.theme_stats.iter().find(|t| t.theme == "fork").unwrap();
        assert_eq!((fork.attempts, fork.solved, fork.recent_attempts), (2, 2, 2));
        assert!(store.attempted_puzzle_ids().unwrap().contains(&7));
    }

    #[test]
    fn maia_summary_levels_openings_and_adaptive_elo() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.maia_summary().unwrap().suggested_elo, 1100, "default start");
        let rec = |result: &str, opening: &str, color: &str| crate::training::MaiaGameRecord {
            game_id: format!("maia:{result}{opening}"),
            color: color.into(),
            elo: 1100,
            result: result.into(),
            plies: 40,
            opening: Some(opening.into()),
            hints: 0,
            takebacks: 0,
            time_control: None,
            pgn: String::new(),
        };
        store.record_maia_game(&rec("win", "Italian Game", "white")).unwrap();
        store.record_maia_game(&rec("loss", "Sicilian Defense", "black")).unwrap();
        store.record_maia_game(&rec("win", "Italian Game", "white")).unwrap();
        let s = store.maia_summary().unwrap();
        assert_eq!((s.games, s.wins, s.losses), (3, 2, 1));
        assert_eq!(s.suggested_elo, 1150, "2 of last 3 at 1100 -> step up");
        assert_eq!(s.openings[0].name, "Italian Game");
        assert_eq!((s.openings[0].games, s.openings[0].score), (2, 100));
        assert_eq!(s.by_level[0].elo, 1100);
        assert_eq!(s.recent[0].result, "win");
    }

    #[test]
    fn today_counts_marks_history_and_lookback() {
        let store = Store::open_in_memory().unwrap();
        let tz = -360; // America/Chicago (CST)
        let today = store.local_today(tz).unwrap();
        let c = store.today_counts(tz).unwrap();
        assert_eq!(c.date, today);
        assert_eq!((c.drills_reviewed, c.focus_puzzles, c.maia_games), (0, 0, 0));

        store.save_card(1, "{}", "2030-01-01T00:00:00Z", false).unwrap_or(());
        store
            .record_puzzle_attempt(&crate::training::PuzzleAttempt {
                puzzle_id: 1,
                rating: 1200,
                themes: vec!["fork".into()],
                weakness: Some("Warm-up".into()),
                solved: true,
                hints: 0,
                seconds: 5.0,
            })
            .unwrap();
        store
            .record_puzzle_attempt(&crate::training::PuzzleAttempt {
                puzzle_id: 2,
                rating: 1200,
                themes: vec!["fork".into()],
                weakness: Some("Loose pieces".into()),
                solved: false,
                hints: 0,
                seconds: 5.0,
            })
            .unwrap();
        store.set_mark(&today, "lookback", true).unwrap();
        store.set_mark(&today, "lesson_complete", true).unwrap();
        store.set_mark(&today, "lesson_complete", true).unwrap(); // idempotent
        let c = store.today_counts(tz).unwrap();
        assert_eq!((c.warmup_puzzles, c.focus_puzzles), (1, 1));
        assert_eq!(c.marks, vec!["lesson_complete".to_string(), "lookback".to_string()]);

        let h = store.history(7, tz).unwrap();
        assert_eq!(h.len(), 7);
        assert_eq!(h[6].date, today);
        assert!(h[6].lesson_complete);
        assert_eq!(h[6].puzzles, 2);
        assert!(!h[5].lesson_complete);

        store.set_mark(&today, "lookback", false).unwrap();
        assert_eq!(store.today_counts(tz).unwrap().marks, vec!["lesson_complete".to_string()]);
        assert!(store.lookback_mistake(tz).unwrap().is_none());
    }

    #[test]
    fn migrates_build2_database() {
        let path = std::env::temp_dir().join("coach_migrate_test.db");
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            // Build-2 era tables (without the Drills v2 columns).
            c.execute_batch(
                "CREATE TABLE games (id TEXT PRIMARY KEY, player_color TEXT NOT NULL, white TEXT, black TEXT,
                   white_elo INTEGER, black_elo INTEGER, result TEXT, date TEXT, time_control TEXT, opening TEXT,
                   eco TEXT, url TEXT, plies INTEGER, engine TEXT, depth INTEGER, analyzed_at TEXT);
                 CREATE TABLE mistakes (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, ply INTEGER NOT NULL);
                 INSERT INTO games (id, player_color) VALUES ('g1', 'white');",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        store.backfill_game_moves("g1", None, "e2e4 e7e5").unwrap();
        let moves: String = store
            .conn
            .query_row("SELECT moves_uci FROM games WHERE id='g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(moves, "e2e4 e7e5");
        // Re-opening is a no-op.
        drop(store);
        Store::open(&path).unwrap();
    }

    #[test]
    fn roundtrip_game_mistake_card_and_insight() {
        let pgn = "[White \"me\"]\n[Black \"you\"]\n[UTCDate \"2026.11.01\"]\n[TimeControl \"180+2\"]\n\n1. e4 e5 2. Nf3 Qg5 *\n";
        let g = &parse_pgn_str(pgn)[0];
        let store = Store::open_in_memory().unwrap();
        let p: shakmaty::Chess =
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
                .parse::<shakmaty::fen::Fen>()
                .unwrap()
                .into_position(shakmaty::CastlingMode::Standard)
                .unwrap();
        let played = parse_uci(&p, "d8g5").unwrap();
        let before = [EvalLine { score: EngineScore::Cp(-30), pv: vec!["b8c6".into()] }];
        let after = EvalLine { score: EngineScore::Cp(900), pv: vec!["f3g5".into()] };
        let d = classify_ply(&PlyInput {
            pos_before: &p,
            played: &played,
            ply: 3,
            lines_before: &before,
            line_after: Some(&after),
            terminal_after: None,
            clock_before: None,
            clock_after: None,
            base_secs: None,
            increment_secs: 0.0,
        })
        .unwrap();
        let row = GameRow::from_parsed(g, shakmaty::Color::Black, "/x/stockfish", 12);
        store
            .insert_game_with_mistakes(
                &row,
                &[NewMistake {
                    ply: 3,
                    fen_before: fen_of(&p),
                    clock_secs: None,
                    detected: d,
                    best_line_uci: vec!["b8c6".into()],
                    refutation_uci: vec!["f3g5".into()],
                    second: Some(("g8f6".into(), -40)),
                }],
            )
            .unwrap();
        assert!(store.has_game(&row.id).unwrap());

        let stats = store.stats().unwrap();
        assert_eq!(stats.games, 1);
        assert_eq!(stats.blunders, 1);
        assert!(stats.by_tag.iter().any(|r| r.key == "hung_piece"));
        assert_eq!(stats.by_time_control[0].key, "blitz");
        assert_eq!(stats.monthly_rate[0].month, "2026-11");

        let q = store.drill_queue(&["hung_piece".into()], 10, 5).unwrap();
        assert_eq!(q.len(), 1);
        assert!(q[0].focus);
        assert!(q[0].card_json.is_none());
        assert_eq!(q[0].mistake.opponent, "me");
        assert_eq!(q[0].mistake.second_uci.as_deref(), Some("g8f6"));
        assert_eq!(q[0].mistake.second_cp, Some(-40));
        let ctx = store.mistake_context(q[0].mistake.id).unwrap();
        assert_eq!(ctx.prev_move_san.as_deref(), Some("Nf3"));
        assert_eq!(ctx.game_continuation_san, vec!["Qg5"]);

        store.save_card(q[0].mistake.id, "{}", "2000-01-01T00:00:00.000Z", false).unwrap();
        let q = store.drill_queue(&[], 10, 5).unwrap();
        assert_eq!(q.len(), 1, "card is due");
        assert!(q[0].card_json.is_some());

        store
            .save_insight(
                1,
                r#"{"summary":"s","weaknesses":[{"title":"Hanging pieces","evidence":"e","rule_of_thumb":"r","mistake_ids":[1],"drill_tags":["hung_piece"],"puzzle_themes":["hangingPiece"],"priority":1}],"strengths":["a"],"plan":["p"],"progress_note":"n"}"#,
            )
            .unwrap();
        assert_eq!(store.focus_tags().unwrap(), vec!["hung_piece".to_string()]);
    }
}
