//! Pure chess logic: turn engine evaluations into classified, tagged mistakes,
//! and produce *verified* plain-English facts for the AI coach to explain.
//!
//! Nothing here guesses: every tag and fact is computed from the board with shakmaty
//! or from the engine's principal variations. The language model only rephrases these.

use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, Bitboard, CastlingMode, Chess, Color, EnPassantMode,
    Move, Position, Role, Square,
};

/// Engine score from the point of view of the side to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineScore {
    Cp(i32),
    /// Mate in N. Positive = side to move mates; negative/zero = side to move gets mated.
    Mate(i32),
}

impl EngineScore {
    pub fn negate(self) -> Self {
        match self {
            EngineScore::Cp(x) => EngineScore::Cp(-x),
            EngineScore::Mate(m) => EngineScore::Mate(-m),
        }
    }
    pub fn is_mate_for_mover(self) -> bool {
        matches!(self, EngineScore::Mate(m) if m > 0)
    }
    pub fn is_mate_against_mover(self) -> bool {
        matches!(self, EngineScore::Mate(m) if m <= 0)
    }
}

pub const CP_CEILING: i32 = 1000;

pub fn to_cp(s: EngineScore) -> i32 {
    match s {
        EngineScore::Cp(x) => x.clamp(-CP_CEILING, CP_CEILING),
        EngineScore::Mate(m) if m > 0 => CP_CEILING,
        EngineScore::Mate(_) => -CP_CEILING,
    }
}

/// Same curve En Croissant (and Lichess) use for accuracy / annotations.
pub fn win_chance(cp: i32) -> f32 {
    let cp = cp as f64;
    (50.0 + 50.0 * (2.0 / (1.0 + (-0.00368208 * cp).exp()) - 1.0)) as f32
}

#[derive(Debug, Clone)]
pub struct EvalLine {
    pub score: EngineScore,
    /// UCI moves.
    pub pv: Vec<String>,
}

/// State of the position after the played move, when the game ended there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    /// The mover delivered checkmate.
    MateDelivered,
    Draw,
}

pub struct PlyInput<'a> {
    pub pos_before: &'a Chess,
    pub played: &'a Move,
    pub ply: u32,
    /// Engine lines at `pos_before` (mover's POV), best first.
    pub lines_before: &'a [EvalLine],
    /// Engine best line at the position after the move (opponent's POV). `None` if terminal.
    pub line_after: Option<&'a EvalLine>,
    pub terminal_after: Option<Terminal>,
    /// Mover's clock *before* this move (seconds), from the previous %clk of the same side.
    pub clock_before: Option<f32>,
    /// Mover's clock right after this move.
    pub clock_after: Option<f32>,
    pub base_secs: Option<f32>,
    pub increment_secs: f32,
}

#[derive(Debug, Clone)]
pub struct Detected {
    pub severity: &'static str,
    pub phase: &'static str,
    pub moved_role: &'static str,
    pub eval_before_cp: i32,
    pub eval_after_cp: i32,
    pub win_before: f32,
    pub win_after: f32,
    pub win_drop: f32,
    pub played_uci: String,
    pub played_san: String,
    pub best_uci: String,
    pub best_san: String,
    pub best_line_san: String,
    pub refutation_san: String,
    pub time_spent_secs: Option<f32>,
    pub tags: Vec<String>,
}

pub fn role_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 1,
        Role::Knight | Role::Bishop => 3,
        Role::Rook => 5,
        Role::Queen => 9,
        Role::King => 0,
    }
}

pub fn role_name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}

pub fn parse_uci(pos: &Chess, uci: &str) -> Option<Move> {
    UciMove::from_ascii(uci.as_bytes()).ok()?.to_move(pos).ok()
}

pub fn move_to_uci(m: &Move) -> String {
    m.to_uci(CastlingMode::Standard).to_string()
}

pub fn move_to_san(pos: &Chess, m: &Move) -> String {
    SanPlus::from_move(pos.clone(), *m).to_string()
}

/// Convert a UCI line to SAN, stopping at the first illegal move.
pub fn uci_line_to_san(pos: &Chess, line: &[String], max_plies: usize) -> Vec<String> {
    let mut pos = pos.clone();
    let mut out = Vec::new();
    for uci in line.iter().take(max_plies) {
        let Some(m) = parse_uci(&pos, uci) else { break };
        out.push(move_to_san(&pos, &m));
        pos.play_unchecked(m);
    }
    out
}

pub fn fen_of(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}

fn non_pawn_material(pos: &Chess) -> i32 {
    let b = pos.board();
    b.occupied()
        .into_iter()
        .filter_map(|sq| b.piece_at(sq))
        .filter(|p| p.role != Role::Pawn)
        .map(|p| role_value(p.role))
        .sum()
}

/// Material balance from `color`'s point of view, in pawns.
pub fn material_balance(pos: &Chess, color: Color) -> i32 {
    let b = pos.board();
    b.occupied()
        .into_iter()
        .filter_map(|sq| b.piece_at(sq))
        .map(|p| {
            let v = role_value(p.role);
            if p.color == color {
                v
            } else {
                -v
            }
        })
        .sum()
}

/// Material change (in pawns, from `color`'s view) after playing `line` from `pos`.
/// Uses the better of the last two plies so a line cut off mid-exchange doesn't
/// over-count (e.g. ending right after a capture, before the recapture).
pub fn line_material_delta(pos: &Chess, line: &[String], color: Color, max_plies: usize) -> i32 {
    let start = material_balance(pos, color);
    let mut p = pos.clone();
    let mut history = vec![start];
    for u in line.iter().take(max_plies) {
        match parse_uci(&p, u) {
            Some(m) => p.play_unchecked(m),
            None => break,
        }
        history.push(material_balance(&p, color));
    }
    let n = history.len();
    let end = if n >= 2 { history[n - 1].max(history[n - 2]) } else { history[n - 1] };
    end - start
}

pub fn phase_of(pos: &Chess, ply: u32) -> &'static str {
    let npm = non_pawn_material(pos);
    if ply < 20 && npm >= 50 {
        "opening"
    } else if npm <= 26 {
        "endgame"
    } else {
        "middlegame"
    }
}

fn attackers(pos: &Chess, sq: Square, by: Color) -> Bitboard {
    let b = pos.board();
    b.attacks_to(sq, by, b.occupied())
}

fn min_attacker_value(pos: &Chess, attackers: Bitboard) -> i32 {
    attackers
        .into_iter()
        .filter_map(|s| pos.board().piece_at(s))
        .map(|p| if p.role == Role::King { 100 } else { role_value(p.role) })
        .min()
        .unwrap_or(100)
}

/// A piece is "hanging" if it can be taken for profit: attacked and undefended,
/// or attacked by something cheaper than itself.
pub fn is_hanging(pos: &Chess, sq: Square) -> bool {
    let Some(piece) = pos.board().piece_at(sq) else {
        return false;
    };
    if piece.role == Role::King {
        return false;
    }
    let att = attackers(pos, sq, !piece.color);
    if att.is_empty() {
        return false;
    }
    let def = attackers(pos, sq, piece.color);
    def.is_empty() || min_attacker_value(pos, att) < role_value(piece.role)
}

/// Pieces of `color` worth at least `min_value` that are hanging.
pub fn hanging_pieces(pos: &Chess, color: Color, min_value: i32) -> Vec<(Square, Role)> {
    let b = pos.board();
    b.by_color(color)
        .into_iter()
        .filter_map(|sq| b.piece_at(sq).map(|p| (sq, p.role)))
        .filter(|(sq, role)| role_value(*role) >= min_value && is_hanging(pos, *sq))
        .collect()
}

/// Valuable enemy targets attacked by the piece on `sq` (which belongs to the side that
/// just moved, i.e. `!pos.turn()`). Counts the king (check), higher-value pieces,
/// and undefended minor-or-better pieces.
pub fn fork_targets(pos: &Chess, sq: Square) -> Vec<(Square, Role)> {
    let b = pos.board();
    let Some(attacker) = b.piece_at(sq) else {
        return vec![];
    };
    let enemy = !attacker.color;
    let av = role_value(attacker.role);
    (b.attacks_from(sq) & b.by_color(enemy))
        .into_iter()
        .filter_map(|t| b.piece_at(t).map(|p| (t, p.role)))
        .filter(|(t, role)| {
            *role == Role::King
                || role_value(*role) > av
                || (role_value(*role) >= 3 && attackers(pos, *t, enemy).is_empty())
        })
        .collect()
}

fn is_fork(pos_after_move: &Chess, to: Square) -> bool {
    let targets = fork_targets(pos_after_move, to);
    if targets.len() < 2 {
        return false;
    }
    // A "fork" by a piece that is simply lost for free is not a fork unless it checks.
    let gives_check = targets.iter().any(|(_, r)| *r == Role::King);
    gives_check || !is_hanging(pos_after_move, to)
}

fn add_tag(tags: &mut Vec<String>, t: &str) {
    if !tags.iter().any(|x| x == t) {
        tags.push(t.to_string());
    }
}

pub fn severity_of(drop: f32) -> Option<&'static str> {
    if drop > 20.0 {
        Some("blunder")
    } else if drop > 10.0 {
        Some("mistake")
    } else if drop > 5.0 {
        Some("inaccuracy")
    } else {
        None
    }
}

/// Classify a single move. Returns `None` if it was not an inaccuracy or worse.
pub fn classify_ply(input: &PlyInput) -> Option<Detected> {
    let best = input.lines_before.first()?;
    let pos = input.pos_before;
    let played_uci = move_to_uci(input.played);

    // Engine's top move: never a mistake even if a tiny eval wobble says so.
    if best.pv.first().map(|m| m == &played_uci).unwrap_or(false) {
        return None;
    }

    let score_after_mover = match (input.terminal_after, input.line_after) {
        (Some(Terminal::MateDelivered), _) => EngineScore::Mate(1),
        (Some(Terminal::Draw), _) => EngineScore::Cp(0),
        (None, Some(l)) => l.score.negate(),
        (None, None) => return None,
    };

    let eval_before = to_cp(best.score);
    let eval_after = to_cp(score_after_mover);
    let win_before = win_chance(eval_before);
    let win_after = win_chance(eval_after);
    let drop = win_before - win_after;
    let severity = severity_of(drop)?;

    let mut pos_after = pos.clone();
    pos_after.play_unchecked(*input.played);

    let mut tags: Vec<String> = Vec::new();

    // --- mate-related -----------------------------------------------------------------
    if best.score.is_mate_for_mover() && !score_after_mover.is_mate_for_mover() {
        add_tag(&mut tags, "missed_mate");
    }
    if score_after_mover.is_mate_against_mover() && !best.score.is_mate_against_mover() {
        add_tag(&mut tags, "allowed_mate");
    }

    // --- what the opponent's refutation does ---------------------------------------------
    let refutation: Vec<String> = input.line_after.map(|l| l.pv.clone()).unwrap_or_default();
    if let Some(r) = refutation.first().and_then(|u| parse_uci(&pos_after, u)) {
        if r.is_capture() && !r.is_en_passant() {
            let target = r.to();
            if let Some(victim) = pos_after.board().piece_at(target) {
                if role_value(victim.role) >= 3 && is_hanging(&pos_after, target) {
                    add_tag(&mut tags, "hung_piece");
                    if target == input.played.to() {
                        // You moved the piece to a square where it gets taken.
                        add_tag(&mut tags, "moved_piece_en_prise");
                    } else if is_hanging(pos, target) {
                        // It was already hanging before your move: you missed their threat.
                        add_tag(&mut tags, "ignored_threat");
                    } else {
                        // Your move removed a defender / opened a line.
                        add_tag(&mut tags, "removed_defender");
                    }
                }
            }
        }
        let mut pos_r = pos_after.clone();
        pos_r.play_unchecked(r);
        if is_fork(&pos_r, r.to()) {
            add_tag(&mut tags, "allowed_fork");
        }
        if pos_r.is_check() && drop > 10.0 && !tags.iter().any(|t| t == "allowed_mate") {
            add_tag(&mut tags, "allowed_king_attack");
        }
    }

    // --- what you could have played instead -------------------------------------------------
    if let Some(b) = best.pv.first().and_then(|u| parse_uci(pos, u)) {
        if b.is_capture() && !b.is_en_passant() {
            if let Some(victim) = pos.board().piece_at(b.to()) {
                if role_value(victim.role) >= 3 && is_hanging(pos, b.to()) {
                    add_tag(&mut tags, "missed_free_piece");
                }
            }
        }
        let mut pos_b = pos.clone();
        pos_b.play_unchecked(b);
        if is_fork(&pos_b, b.to()) {
            add_tag(&mut tags, "missed_fork");
        }
    }

    // --- material outcome of both lines (robust to multi-move tactics) -------------------
    let mover = pos.turn();
    let mut played_then_refuted: Vec<String> = vec![played_uci.clone()];
    played_then_refuted.extend(refutation.iter().cloned());
    let played_delta = line_material_delta(pos, &played_then_refuted, mover, 9);
    let best_delta = line_material_delta(pos, &best.pv, mover, 8);
    if played_delta <= -2 {
        add_tag(&mut tags, "lost_material");
    }
    if best_delta - played_delta >= 2 && best_delta >= 1 {
        add_tag(&mut tags, "missed_material");
    }
    // A loose piece that was hanging before the move is still hanging after it.
    let still_hanging = hanging_pieces(pos, mover, 3)
        .into_iter()
        .any(|(sq, _)| sq != input.played.from().unwrap_or(sq) && is_hanging(&pos_after, sq));
    if still_hanging && played_delta <= -2 {
        add_tag(&mut tags, "ignored_threat");
    }

    // --- context ------------------------------------------------------------------------
    if win_before >= 70.0 {
        add_tag(&mut tags, "was_winning");
    } else if win_before <= 30.0 {
        add_tag(&mut tags, "was_losing");
    }

    let time_spent = match (input.clock_before, input.clock_after) {
        (Some(b), Some(a)) => Some((b - a + input.increment_secs).max(0.0)),
        _ => None,
    };
    if let Some(cb) = input.clock_before {
        let threshold = input.base_secs.map(|b| (b * 0.1).max(30.0)).unwrap_or(30.0);
        if cb < threshold {
            add_tag(&mut tags, "time_pressure");
        }
    }
    if let Some(ts) = time_spent {
        let in_time_trouble = tags.iter().any(|t| t == "time_pressure");
        if ts <= 3.0 && input.ply > 16 && !in_time_trouble && severity != "inaccuracy" {
            add_tag(&mut tags, "rushed");
        }
    }

    const TACTICAL: [&str; 11] = [
        "lost_material",
        "missed_material",
        "missed_mate",
        "allowed_mate",
        "hung_piece",
        "allowed_fork",
        "allowed_king_attack",
        "missed_free_piece",
        "missed_fork",
        "ignored_threat",
        "removed_defender",
    ];
    if !tags.iter().any(|t| TACTICAL.contains(&t.as_str())) {
        add_tag(&mut tags, "positional");
    }

    let best_san_line = uci_line_to_san(pos, &best.pv, 8);
    let refutation_san = uci_line_to_san(&pos_after, &refutation, 8);

    Some(Detected {
        severity,
        phase: phase_of(pos, input.ply),
        moved_role: role_name(input.played.role()),
        eval_before_cp: eval_before,
        eval_after_cp: eval_after,
        win_before,
        win_after,
        win_drop: drop,
        played_san: move_to_san(pos, input.played),
        played_uci,
        best_uci: best.pv.first().cloned().unwrap_or_default(),
        best_san: best_san_line.first().cloned().unwrap_or_default(),
        best_line_san: best_san_line.join(" "),
        refutation_san: refutation_san.join(" "),
        time_spent_secs: time_spent,
        tags,
    })
}

fn describe(role: Role, sq: Square) -> String {
    format!("{} on {}", role_name(role), sq)
}

/// Verified, human-readable facts about a mistake, computed from the board.
/// These are what the AI coach is allowed to talk about.
pub fn explain_facts(
    fen_before: &str,
    played_uci: &str,
    best_line_uci: &[String],
    refutation_uci: &[String],
) -> Vec<String> {
    let mut facts = Vec::new();
    let Ok(fen) = fen_before.parse::<Fen>() else {
        return facts;
    };
    let Ok(pos): Result<Chess, _> = fen.into_position(CastlingMode::Standard) else {
        return facts;
    };
    let mover = pos.turn();
    let Some(played) = parse_uci(&pos, played_uci) else {
        return facts;
    };

    // Threats that already existed before the move.
    for (sq, role) in hanging_pieces(&pos, mover, 3) {
        let att: Vec<String> = attackers(&pos, sq, !mover)
            .into_iter()
            .filter_map(|s| pos.board().piece_at(s).map(|p| describe(p.role, s)))
            .collect();
        facts.push(format!(
            "Before your move, your {} was already under attack (by {}) and not adequately defended.",
            describe(role, sq),
            att.join(", ")
        ));
    }

    let mut after = pos.clone();
    after.play_unchecked(played);
    let played_san = move_to_san(&pos, &played);

    for (sq, role) in hanging_pieces(&after, mover, 3) {
        let att: Vec<String> = attackers(&after, sq, !mover)
            .into_iter()
            .filter_map(|s| after.board().piece_at(s).map(|p| describe(p.role, s)))
            .collect();
        facts.push(format!(
            "After {}, your {} can be won: it is attacked by {} and not adequately defended.",
            played_san,
            describe(role, sq),
            att.join(", ")
        ));
    }

    if let Some(r) = refutation_uci.first().and_then(|u| parse_uci(&after, u)) {
        let r_san = move_to_san(&after, &r);
        let mut pr = after.clone();
        pr.play_unchecked(r);
        if let Some(victim) = after.board().piece_at(r.to()) {
            if r.is_capture() {
                facts.push(format!(
                    "The opponent's best reply {} captures your {}.",
                    r_san,
                    describe(victim.role, r.to())
                ));
            }
        }
        let targets = fork_targets(&pr, r.to());
        if targets.len() >= 2 {
            let list: Vec<String> = targets.iter().map(|(s, ro)| describe(*ro, *s)).collect();
            facts.push(format!(
                "The reply {} attacks several targets at once: {}.",
                r_san,
                list.join(" and ")
            ));
        } else if pr.is_check() {
            facts.push(format!("The reply {} gives check.", r_san));
        }

        // Material outcome of the refutation line.
        let mut pl = after.clone();
        for u in refutation_uci.iter().take(8) {
            match parse_uci(&pl, u) {
                Some(m) => pl.play_unchecked(m),
                None => break,
            }
        }
        let delta = material_balance(&pl, mover) - material_balance(&after, mover);
        if delta <= -2 {
            facts.push(format!(
                "Following the engine's line, you end up about {} points of material down compared with after your move.",
                -delta
            ));
        }
    }

    if let Some(b) = best_line_uci.first().and_then(|u| parse_uci(&pos, u)) {
        let b_san = move_to_san(&pos, &b);
        let mut pb = pos.clone();
        pb.play_unchecked(b);
        if b.is_capture() {
            if let Some(victim) = pos.board().piece_at(b.to()) {
                let free = is_hanging(&pos, b.to());
                facts.push(format!(
                    "The best move {} captures the {}{}.",
                    b_san,
                    describe(victim.role, b.to()),
                    if free { ", which was not adequately defended" } else { "" }
                ));
            }
        }
        let targets = fork_targets(&pb, b.to());
        if targets.len() >= 2 {
            let list: Vec<String> = targets.iter().map(|(s, ro)| describe(*ro, *s)).collect();
            facts.push(format!(
                "The best move {} attacks several targets at once: {}.",
                b_san,
                list.join(" and ")
            ));
        } else if pb.is_check() {
            facts.push(format!("The best move {} gives check.", b_san));
        }
        let mut pl = pos.clone();
        for u in best_line_uci.iter().take(8) {
            match parse_uci(&pl, u) {
                Some(m) => pl.play_unchecked(m),
                None => break,
            }
        }
        let delta = material_balance(&pl, mover) - material_balance(&pos, mover);
        if delta >= 2 {
            facts.push(format!(
                "Following the best line, you win about {} points of material.",
                delta
            ));
        }
    }

    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(fen: &str) -> Chess {
        fen.parse::<Fen>()
            .unwrap()
            .into_position(CastlingMode::Standard)
            .unwrap()
    }

    fn line(score: EngineScore, pv: &[&str]) -> EvalLine {
        EvalLine {
            score,
            pv: pv.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn win_chance_is_symmetric() {
        assert!((win_chance(0) - 50.0).abs() < 1e-4);
        assert!((win_chance(300) + win_chance(-300) - 100.0).abs() < 1e-3);
    }

    #[test]
    fn detects_moved_piece_en_prise() {
        // After 1.e4 e5 2.Nf3, black plays 2...Qg5?? and the knight takes it.
        let p = pos("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2");
        let played = parse_uci(&p, "d8g5").unwrap();
        let before = [line(EngineScore::Cp(-30), &["b8c6", "f1b5"])];
        let after = line(EngineScore::Cp(900), &["f3g5", "f8e7"]);
        let d = classify_ply(&PlyInput {
            pos_before: &p,
            played: &played,
            ply: 3,
            lines_before: &before,
            line_after: Some(&after),
            terminal_after: None,
            clock_before: Some(170.0),
            clock_after: Some(169.0),
            base_secs: Some(180.0),
            increment_secs: 0.0,
        })
        .expect("should be a mistake");
        assert_eq!(d.severity, "blunder");
        assert!(d.tags.contains(&"hung_piece".to_string()), "{:?}", d.tags);
        assert!(d.tags.contains(&"moved_piece_en_prise".to_string()));
        assert_eq!(d.played_san, "Qg5");
        assert_eq!(d.refutation_san.split(' ').next(), Some("Nxg5"));
        assert_eq!(d.phase, "opening");
    }

    #[test]
    fn detects_missed_fork() {
        // Black king h8, queen d8, white knight g5: Nf7+ forks king and queen.
        let p = pos("3q3k/8/8/6N1/8/8/8/6K1 w - - 0 40");
        let played = parse_uci(&p, "g1f2").unwrap();
        let before = [line(EngineScore::Cp(700), &["g5f7", "h8g8", "f7d8"])];
        let after = line(EngineScore::Cp(0), &["d8d2"]);
        let d = classify_ply(&PlyInput {
            pos_before: &p,
            played: &played,
            ply: 79,
            lines_before: &before,
            line_after: Some(&after),
            terminal_after: None,
            clock_before: None,
            clock_after: None,
            base_secs: None,
            increment_secs: 0.0,
        })
        .expect("mistake");
        assert!(d.tags.contains(&"missed_fork".to_string()), "{:?}", d.tags);
        assert!(d.tags.contains(&"was_winning".to_string()));
        assert_eq!(d.phase, "endgame");
    }

    #[test]
    fn best_move_is_never_a_mistake() {
        let p = Chess::default();
        let played = parse_uci(&p, "e2e4").unwrap();
        let before = [line(EngineScore::Cp(30), &["e2e4"])];
        let after = line(EngineScore::Cp(500), &["e7e5"]);
        assert!(classify_ply(&PlyInput {
            pos_before: &p,
            played: &played,
            ply: 0,
            lines_before: &before,
            line_after: Some(&after),
            terminal_after: None,
            clock_before: None,
            clock_after: None,
            base_secs: None,
            increment_secs: 0.0,
        })
        .is_none());
    }

    #[test]
    fn facts_mention_the_capture() {
        let facts = explain_facts(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
            "d8g5",
            &["b8c6".into()],
            &["f3g5".into(), "f8e7".into()],
        );
        let joined = facts.join("\n");
        assert!(joined.contains("captures your queen on g5"), "{joined}");
    }
}
