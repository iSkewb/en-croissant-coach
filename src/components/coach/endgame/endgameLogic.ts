// Pure logic for endgame drills: position generators, the tablebase/engine "oracle"
// mapping, and judging each move against the drill's goal. Unit-tested.
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { positionFromFen } from "@/utils/chessops";
import type { Generator, Goal } from "./curriculum";

// ---------- random positions ----------

export type Rng = () => number;

/** Small deterministic PRNG (mulberry32). */
export function makeRng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Sq = { f: number; r: number }; // file 0-7 (a-h), rank 0-7 (1-8)
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const dist = (a: Sq, b: Sq) => Math.max(Math.abs(a.f - b.f), Math.abs(a.r - b.r));
const same = (a: Sq, b: Sq) => a.f === b.f && a.r === b.r;

export function buildFen(pieces: [string, Sq][], turn: "w" | "b"): string {
    const rows: string[] = [];
    for (let r = 7; r >= 0; r--) {
        let row = "";
        let empty = 0;
        for (let f = 0; f < 8; f++) {
            const p = pieces.find(([, s]) => s.f === f && s.r === r);
            if (p) {
                if (empty) row += empty;
                empty = 0;
                row += p[0];
            } else empty++;
        }
        rows.push(row + (empty ? empty : ""));
    }
    return `${rows.join("/")} ${turn} - - 0 1`;
}

export type Candidate = { fen: string; orientation: "white" | "black" };

/** The result the user must be able to keep from a generated position. */
export function requiredVerdict(g: Generator): Verdict {
    return g === "catchPawn" || g === "kpkHold" ? "draw" : "win";
}

/** Generators for the mates always give winning positions; the pawn ones need checking. */
export const needsCheck = (g: Generator) => g === "catchPawn" || g === "kpkWin" || g === "kpkHold";

function legal(fen: string): boolean {
    const [pos] = positionFromFen(fen);
    return !!pos && !pos.isEnd();
}

export function generateCandidate(g: Generator, rng: Rng): Candidate {
    for (let tries = 0; tries < 500; tries++) {
        const c = tryGenerate(g, rng);
        if (c && legal(c.fen)) return c;
    }
    throw new Error(`could not generate a ${g} position`);
}

function tryGenerate(g: Generator, rng: Rng): Candidate | null {
    if (g === "ladder" || g === "queen" || g === "rook") {
        // Lone black king somewhere central so there's real work to do.
        const bk = { f: int(rng, 2, 5), r: int(rng, 2, 5) };
        const wk = { f: int(rng, 0, 7), r: int(rng, 0, 7) };
        if (dist(bk, wk) < 2) return null;
        const heavy = g === "ladder" ? ["R", "R"] : g === "queen" ? ["Q"] : ["R"];
        const pieces: [string, Sq][] = [
            ["K", wk],
            ["k", bk],
        ];
        for (const p of heavy) {
            const s = { f: int(rng, 0, 7), r: int(rng, 0, 7) };
            // Not capturable or touching the king, and not already giving check (white to move).
            if (dist(s, bk) < 2 || pieces.some(([, q]) => same(q, s))) return null;
            if (s.f === bk.f || s.r === bk.r) return null;
            if (p === "Q" && Math.abs(s.f - bk.f) === Math.abs(s.r - bk.r)) return null;
            pieces.push([p, s]);
        }
        return { fen: buildFen(pieces, "w"), orientation: "white" };
    }
    if (g === "kpkWin") {
        // White pawn with its king close by; black king in front, close enough to stop a lone pawn.
        const p = { f: int(rng, 1, 6), r: int(rng, 1, 4) };
        const wk = { f: p.f + int(rng, -1, 1), r: p.r + int(rng, 0, 2) };
        const bk = { f: p.f + int(rng, -2, 2), r: p.r + int(rng, 2, 4) };
        if (wk.f < 0 || wk.f > 7 || wk.r > 7 || bk.f < 0 || bk.f > 7 || bk.r > 7) return null;
        if (same(wk, p) || dist(wk, bk) < 2 || dist(bk, p) < 2) return null;
        // The pawn can't simply run: their king is inside the square of the pawn.
        if (dist(bk, { f: p.f, r: 7 }) > 7 - p.r) return null;
        return {
            fen: buildFen(
                [
                    ["K", wk],
                    ["P", p],
                    ["k", bk],
                ],
                "w",
            ),
            orientation: "white",
        };
    }
    if (g === "kpkHold") {
        // You are black, king in front of a white pawn; black to move.
        const p = { f: int(rng, 1, 6), r: int(rng, 1, 4) };
        const wk = { f: p.f + int(rng, -1, 1), r: p.r + int(rng, 0, 2) };
        const bk = { f: p.f + int(rng, -1, 1), r: wk.r + int(rng, 2, 3) };
        if (wk.f < 0 || wk.f > 7 || wk.r > 7 || bk.f < 0 || bk.f > 7 || bk.r > 7) return null;
        if (same(wk, p) || dist(wk, bk) < 2 || dist(bk, p) < 2) return null;
        return {
            fen: buildFen(
                [
                    ["K", wk],
                    ["P", p],
                    ["k", bk],
                ],
                "b",
            ),
            orientation: "black",
        };
    }
    // catchPawn: your lone white king must stop a black pawn; their king is far away.
    const p = { f: int(rng, 1, 6), r: int(rng, 3, 4) };
    const wk = { f: int(rng, 0, 7), r: int(rng, 0, 3) };
    const bk = { f: int(rng, 0, 7), r: int(rng, 5, 7) };
    if (Math.abs(wk.f - p.f) < 3 || dist(bk, p) < 4 || dist(wk, bk) < 2) return null;
    // Just inside the square: catchable, but only with the right path.
    if (dist(wk, { f: p.f, r: 0 }) !== p.r) return null;
    return {
        fen: buildFen(
            [
                ["K", wk],
                ["p", p],
                ["k", bk],
            ],
            "w",
        ),
        orientation: "white",
    };
}

// ---------- the oracle (tablebase first, engine as fallback) ----------

export type Verdict = "win" | "draw" | "loss";
export type OracleResult = {
    verdict: Verdict;
    best: string | null;
    source: "tablebase" | "engine";
};

export function tablebaseVerdict(category: string): Verdict | null {
    switch (category) {
        case "win":
        case "maybe-win":
            return "win";
        case "loss":
        case "maybe-loss":
            return "loss";
        case "draw":
        case "cursed-win":
        case "blessed-loss":
            return "draw";
        default:
            return null;
    }
}

/** Engine score (side to move) to a verdict. Endgames this simple are clear-cut. */
export function engineVerdict(cp: number, mate: number | null): Verdict {
    if (mate !== null && mate !== 0) return mate > 0 ? "win" : "loss";
    if (cp >= 350) return "win";
    if (cp <= -350) return "loss";
    return "draw";
}

export const flip = (v: Verdict): Verdict => (v === "win" ? "loss" : v === "loss" ? "win" : "draw");

// ---------- judging ----------

export type MoveFacts = {
    checkmate: boolean;
    stalemate: boolean;
    insufficient: boolean;
    promoted: boolean;
    /** Your moves played so far, including this one. */
    movesMade: number;
};

export type Fail = "stalemate" | "lostWin" | "lostDraw" | "tooSlow" | "mated";
export type Judgement =
    | { result: "success" }
    | { result: "continue" }
    | { result: "fail"; why: Fail };

/** After YOUR move. `opponent` = the verdict for the side now to move (them), if not game over. */
export function judgeYourMove(goal: Goal, f: MoveFacts, opponent: Verdict | null): Judgement {
    const win = goal.kind !== "hold";
    if (f.checkmate) return { result: "success" };
    if (f.stalemate) return win ? { result: "fail", why: "stalemate" } : { result: "success" };
    if (f.insufficient) return win ? { result: "fail", why: "lostWin" } : { result: "success" };
    if (opponent) {
        if (win && opponent !== "loss") return { result: "fail", why: "lostWin" };
        if (!win && opponent === "win") return { result: "fail", why: "lostDraw" };
    }
    if (goal.kind === "promote" && f.promoted) return { result: "success" };
    if (win && f.movesMade >= goal.maxMoves) return { result: "fail", why: "tooSlow" };
    if (goal.kind === "hold" && f.movesMade >= goal.moves) return { result: "success" };
    return { result: "continue" };
}

/** After THEIR reply. */
export function judgeTheirMove(
    goal: Goal,
    f: Omit<MoveFacts, "promoted" | "movesMade">,
): Judgement {
    const win = goal.kind !== "hold";
    if (f.checkmate) return { result: "fail", why: "mated" };
    if (f.stalemate || f.insufficient)
        return win ? { result: "fail", why: "lostWin" } : { result: "success" };
    return { result: "continue" };
}

export function failText(why: Fail): string {
    switch (why) {
        case "stalemate":
            return "Stalemate. Their king had no legal move, so it's a draw. Always leave them a square until the mating move.";
        case "lostWin":
            return "That move lets the win slip. Take it back and look again.";
        case "lostDraw":
            return "That move loses. Take it back and find a move that keeps the draw.";
        case "tooSlow":
            return "Out of moves. The technique works, but it needs to be faster. Try the position again.";
        case "mated":
            return "Checkmated. Take back your last move.";
    }
}

/** Facts about a position reached by `uci` from `fenBefore`. */
export function factsAfter(fenBefore: string, uci: string) {
    const [pos] = positionFromFen(fenBefore);
    const move = parseUci(uci);
    if (!pos || !move) return null;
    const promoted = "promotion" in move && !!move.promotion;
    pos.play(move);
    return {
        fen: makeFen(pos.toSetup()),
        checkmate: pos.isCheckmate(),
        stalemate: pos.isStalemate(),
        insufficient: pos.isInsufficientMaterial(),
        promoted,
    };
}
