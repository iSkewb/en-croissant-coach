//! Read your downloaded PGN files, analyse your moves with a UCI engine, and store
//! every inaccuracy/mistake/blunder you made (only *your* moves, never the opponent's).

use std::{
    collections::HashMap,
    ops::ControlFlow,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use pgn_reader::{RawComment, RawTag, Reader, SanPlus, Skip, Visitor};
use shakmaty::{fen::Fen, CastlingMode, Chess, Color, Position};

use super::{
    features::{
        classify_ply, fen_of, move_to_uci, parse_uci, EvalLine, PlyInput, Terminal,
    },
    msg,
    store::{GameRow, NewMistake, Store},
    uci::UciEngine,
    IngestOptions, IngestSummary, TResult,
};

#[derive(Debug, Clone, Default)]
pub struct ParsedGame {
    pub headers: HashMap<String, String>,
    pub start_fen: Option<String>,
    pub moves_uci: Vec<String>,
    /// Remaining clock (seconds) of the side that just moved, after each ply.
    pub clocks: Vec<Option<f32>>,
}

impl ParsedGame {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty() && *s != "?")
    }

    /// Stable id: the game URL when the site gives one, otherwise a content hash.
    pub fn id(&self) -> String {
        if let Some(link) = self.header("Link") {
            return link.to_string();
        }
        if let Some(site) = self.header("Site") {
            if site.starts_with("http") {
                return site.to_string();
            }
        }
        let mut h: u64 = 0xcbf29ce484222325;
        let mut feed = |s: &str| {
            for b in s.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
        };
        for k in ["White", "Black", "Date", "UTCDate", "UTCTime", "Result"] {
            feed(self.header(k).unwrap_or(""));
        }
        feed(&self.moves_uci.join(" "));
        format!("hash:{h:016x}")
    }

    pub fn sort_key(&self) -> String {
        let date = self
            .header("UTCDate")
            .or(self.header("Date"))
            .unwrap_or("0000.00.00");
        let time = self
            .header("UTCTime")
            .or(self.header("StartTime"))
            .unwrap_or("00:00:00");
        format!("{date} {time}")
    }

    pub fn player_color(&self, player: &str) -> Option<Color> {
        let p = player.trim().to_lowercase();
        if self.header("White").map(|w| w.to_lowercase()) == Some(p.clone()) {
            Some(Color::White)
        } else if self.header("Black").map(|b| b.to_lowercase()) == Some(p) {
            Some(Color::Black)
        } else {
            None
        }
    }

    /// (base seconds, increment seconds) from a "600+5" style TimeControl.
    pub fn time_control(&self) -> (Option<f32>, f32) {
        let Some(tc) = self.header("TimeControl") else {
            return (None, 0.0);
        };
        if tc.contains('/') {
            // Daily / correspondence ("1/259200"): clocks are meaningless for our purposes.
            return (None, 0.0);
        }
        let mut parts = tc.split('+');
        let base = parts.next().and_then(|b| b.parse::<f32>().ok());
        let inc = parts.next().and_then(|i| i.parse::<f32>().ok()).unwrap_or(0.0);
        (base, inc)
    }

    pub fn initial_position(&self) -> TResult<Chess> {
        match &self.start_fen {
            None => Ok(Chess::default()),
            Some(f) => {
                let fen: Fen = f.parse().map_err(|e| super::TrainingError::Msg(format!("{e}")))?;
                fen.into_position(CastlingMode::Standard)
                    .map_err(|e| super::TrainingError::Msg(format!("{e}")))
            }
        }
    }
}

/// Parse `[%clk 0:02:59.9]` style annotations.
pub fn parse_clock(comment: &str) -> Option<f32> {
    let idx = comment.find("%clk")?;
    let rest = comment[idx + 4..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':' || *c == '.')
        .collect();
    let mut secs = 0.0f32;
    for part in token.split(':') {
        secs = secs * 60.0 + part.parse::<f32>().ok()?;
    }
    Some(secs)
}

struct Collector;

struct Movetext {
    game: ParsedGame,
    pos: Chess,
    comment: String,
    broken: bool,
}

impl Visitor for Collector {
    type Tags = HashMap<String, String>;
    type Movetext = Movetext;
    type Output = Option<ParsedGame>;

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(HashMap::new())
    }

    fn tag(
        &mut self,
        tags: &mut Self::Tags,
        key: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        tags.insert(
            String::from_utf8_lossy(key).into_owned(),
            value.decode_utf8_lossy().into_owned(),
        );
        ControlFlow::Continue(())
    }

    fn begin_movetext(&mut self, tags: Self::Tags) -> ControlFlow<Self::Output, Self::Movetext> {
        if let Some(v) = tags.get("Variant") {
            let v = v.to_lowercase();
            if !(v.is_empty() || v == "standard" || v == "from position") {
                return ControlFlow::Break(None);
            }
        }
        let start_fen = tags.get("FEN").cloned().filter(|f| !f.is_empty());
        let game = ParsedGame {
            headers: tags,
            start_fen,
            ..Default::default()
        };
        let Ok(pos) = game.initial_position() else {
            return ControlFlow::Break(None);
        };
        ControlFlow::Continue(Movetext {
            game,
            pos,
            comment: String::new(),
            broken: false,
        })
    }

    fn san(&mut self, mt: &mut Self::Movetext, san_plus: SanPlus) -> ControlFlow<Self::Output> {
        if mt.broken {
            return ControlFlow::Continue(());
        }
        match san_plus.san.to_move(&mt.pos) {
            Ok(m) => {
                mt.game.moves_uci.push(move_to_uci(&m));
                mt.game.clocks.push(None);
                mt.pos.play_unchecked(m);
            }
            Err(_) => mt.broken = true,
        }
        ControlFlow::Continue(())
    }

    fn partial_comment(
        &mut self,
        mt: &mut Self::Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        mt.comment.push_str(&String::from_utf8_lossy(comment.as_bytes()));
        ControlFlow::Continue(())
    }

    fn comment(
        &mut self,
        mt: &mut Self::Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        let mut text = std::mem::take(&mut mt.comment);
        text.push_str(&String::from_utf8_lossy(comment.as_bytes()));
        if let (Some(c), Some(last)) = (parse_clock(&text), mt.game.clocks.last_mut()) {
            *last = Some(c);
        }
        ControlFlow::Continue(())
    }

    fn begin_variation(&mut self, _mt: &mut Self::Movetext) -> ControlFlow<Self::Output, Skip> {
        ControlFlow::Continue(Skip(true))
    }

    fn end_game(&mut self, mt: Self::Movetext) -> Self::Output {
        Some(mt.game)
    }
}

#[cfg(test)]
pub fn parse_pgn_str(pgn: &str) -> Vec<ParsedGame> {
    parse_pgn_reader(pgn.as_bytes())
}

pub fn parse_pgn_reader<R: std::io::Read>(r: R) -> Vec<ParsedGame> {
    let mut reader = Reader::new(r);
    let mut out = Vec::new();
    loop {
        match reader.read_game(&mut Collector) {
            Ok(Some(Some(g))) => out.push(g),
            Ok(Some(None)) => continue, // skipped (variant / bad FEN)
            Ok(None) => break,
            Err(_) => break,
        }
    }
    out
}

/// Analyse one game and return the mistakes made by `color`.
pub async fn analyze_parsed_game(
    engine: &mut UciEngine,
    game: &ParsedGame,
    color: Color,
    depth: u32,
    cancel: &AtomicBool,
) -> TResult<Option<Vec<NewMistake>>> {
    let start = game.initial_position()?;
    let start_fen = fen_of(&start);
    let (base, inc) = game.time_control();

    // Positions 0..=n. We need engine lines for every position where *you* are to move
    // and for the position right after each of your moves.
    let mut positions = vec![start.clone()];
    let mut pos = start.clone();
    for u in &game.moves_uci {
        let Some(m) = parse_uci(&pos, u) else {
            return msg("illegal move in stored game");
        };
        pos.play_unchecked(m);
        positions.push(pos.clone());
    }

    let mut lines: Vec<Option<Vec<EvalLine>>> = vec![None; positions.len()];
    for (i, p) in positions.iter().enumerate() {
        let mine = p.turn() == color;
        let after_mine = i > 0 && positions[i - 1].turn() == color;
        if !(mine || after_mine) || p.is_game_over() {
            continue;
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let multipv = if mine { 2 } else { 1 };
        let res = engine
            .analyse(&start_fen, &game.moves_uci[..i], depth, multipv)
            .await?;
        lines[i] = Some(res);
    }

    let mut mistakes = Vec::new();
    for i in 0..game.moves_uci.len() {
        let before = &positions[i];
        if before.turn() != color {
            continue;
        }
        let Some(lines_before) = lines[i].as_ref() else { continue };
        let after = &positions[i + 1];
        let terminal = if after.is_checkmate() {
            Some(Terminal::MateDelivered)
        } else if after.is_game_over() {
            Some(Terminal::Draw)
        } else {
            None
        };
        let line_after = lines[i + 1].as_ref().and_then(|l| l.first());
        let Some(played) = parse_uci(before, &game.moves_uci[i]) else { continue };

        // Clock of the mover before this move = their clock after their previous move.
        let clock_before = if i >= 2 {
            game.clocks[i - 2]
        } else {
            base
        };
        let clock_after = game.clocks[i];

        if let Some(d) = classify_ply(&PlyInput {
            pos_before: before,
            played: &played,
            ply: i as u32,
            lines_before,
            line_after,
            terminal_after: terminal,
            clock_before: if base.is_some() { clock_before } else { None },
            clock_after: if base.is_some() { clock_after } else { None },
            base_secs: base,
            increment_secs: inc,
        }) {
            mistakes.push(NewMistake {
                ply: i as u32,
                fen_before: fen_of(before),
                clock_secs: clock_before,
                detected: d,
                best_line_uci: lines_before[0].pv.clone(),
                refutation_uci: line_after.map(|l| l.pv.clone()).unwrap_or_default(),
            });
        }
    }
    Ok(Some(mistakes))
}

/// Analyse every not-yet-analysed game of `opts.player` in a PGN file.
/// `progress` receives a 0–100 percentage.
pub async fn ingest_file(
    pgn_path: &Path,
    store_path: &Path,
    opts: &IngestOptions,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(f32) + Send,
) -> TResult<IngestSummary> {
    let file = std::fs::File::open(pgn_path)?;
    let mut games = parse_pgn_reader(std::io::BufReader::new(file));
    games.sort_by_key(|g| std::cmp::Reverse(g.sort_key()));

    let mut summary = IngestSummary {
        games_seen: games.len() as u32,
        ..Default::default()
    };

    let store = Store::open(store_path)?;
    let todo: Vec<(ParsedGame, Color)> = games
        .into_iter()
        .filter_map(|g| {
            let color = g.player_color(&opts.player)?;
            if (g.moves_uci.len() as u32) < opts.min_plies {
                return None;
            }
            Some((g, color))
        })
        .filter(|(g, _)| !store.has_game(&g.id()).unwrap_or(false))
        .take(opts.max_games.unwrap_or(u32::MAX) as usize)
        .collect();
    summary.games_skipped = summary.games_seen - todo.len() as u32;
    drop(store);

    if todo.is_empty() {
        progress(100.0);
        return Ok(summary);
    }

    let mut engine = UciEngine::spawn(&opts.engine_path, opts.threads, opts.hash_mb).await?;
    let total = todo.len() as f32;

    for (idx, (game, color)) in todo.iter().enumerate() {
        progress(idx as f32 / total * 100.0);
        let res = analyze_parsed_game(&mut engine, game, *color, opts.depth, &cancel).await?;
        let Some(mistakes) = res else {
            summary.cancelled = true;
            break;
        };
        let store = Store::open(store_path)?;
        let row = GameRow::from_parsed(game, *color, &opts.engine_path, opts.depth);
        summary.mistakes_found += mistakes.len() as u32;
        store.insert_game_with_mistakes(&row, &mistakes)?;
        summary.games_analyzed += 1;
    }
    engine.quit().await;
    progress(100.0);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PGN: &str = r#"[Event "Live Chess"]
[Site "Chess.com"]
[White "iskewb"]
[Black "someone"]
[Result "0-1"]
[UTCDate "2026.11.01"]
[UTCTime "18:00:00"]
[TimeControl "180+2"]
[Link "https://www.chess.com/game/live/1"]

1. e4 {[%clk 0:03:01]} 1... e5 {[%clk 0:03:01.5]} 2. Nf3 {[%clk 0:02:59]} 2... Qg5 {[%clk 0:02:58]} (2... Nc6 3. Bb5) 3. Nxg5 {[%clk 0:02:58.2]} 0-1

[Event "Variant"]
[Variant "Chess960"]
[White "a"]
[Black "b"]

1. e4 *
"#;

    #[test]
    fn parses_moves_clocks_and_headers() {
        let games = parse_pgn_str(PGN);
        assert_eq!(games.len(), 1, "variant game must be skipped");
        let g = &games[0];
        assert_eq!(g.moves_uci, vec!["e2e4", "e7e5", "g1f3", "d8g5", "f3g5"]);
        assert_eq!(g.clocks[0], Some(181.0));
        assert_eq!(g.clocks[1], Some(181.5));
        assert_eq!(g.clocks[3], Some(178.0));
        assert_eq!(g.player_color("ISKEWB"), Some(Color::White));
        assert_eq!(g.time_control(), (Some(180.0), 2.0));
        assert_eq!(g.id(), "https://www.chess.com/game/live/1");
    }

    #[test]
    fn clock_parser() {
        assert_eq!(parse_clock("[%clk 1:00:00]"), Some(3600.0));
        assert_eq!(parse_clock(" [%eval 0.2] [%clk 0:00:09.4] "), Some(9.4));
        assert_eq!(parse_clock("nothing"), None);
    }
}
