// Pure rules for games against Maia-3 (unit-tested in src/utils/tests/playLogic.test.ts).
import { positionFromFen } from "@/utils/chessops";
import { playUci } from "./drillLogic";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type GameResult = "1-0" | "0-1" | "1/2-1/2";
export type GameEnd = { result: GameResult; reason: string };

export type TimeControl = { id: string; label: string; baseMs: number | null; incMs: number };
export const TIME_CONTROLS: TimeControl[] = [
    { id: "none", label: "No clock", baseMs: null, incMs: 0 },
    { id: "10+0", label: "10 min", baseMs: 10 * 60_000, incMs: 0 },
    { id: "15+10", label: "15 | 10", baseMs: 15 * 60_000, incMs: 10_000 },
    { id: "30+0", label: "30 min", baseMs: 30 * 60_000, incMs: 0 },
];

/** Maia-3 uses the Lichess blitz scale; roughly Chess.com rapid + 350 at club level. */
export const toChessComRapid = (maiaElo: number) => Math.max(100, maiaElo - 350);

/** Position key for repetition: placement, side to move, castling, en passant. */
const repKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

/** Has the game ended after these positions (fens[0] = start)? */
export function gameEnd(fens: string[]): GameEnd | null {
    const fen = fens[fens.length - 1];
    const [pos] = positionFromFen(fen);
    if (!pos) return null;
    if (pos.isCheckmate()) {
        return { result: pos.turn === "white" ? "0-1" : "1-0", reason: "checkmate" };
    }
    if (pos.isStalemate()) return { result: "1/2-1/2", reason: "stalemate" };
    if (pos.isInsufficientMaterial()) return { result: "1/2-1/2", reason: "insufficient material" };
    if (pos.halfmoves >= 100) return { result: "1/2-1/2", reason: "50-move rule" };
    const key = repKey(fen);
    if (fens.filter((f) => repKey(f) === key).length >= 3) {
        return { result: "1/2-1/2", reason: "threefold repetition" };
    }
    return null;
}

export function resultFor(result: GameResult, you: "white" | "black"): "win" | "loss" | "draw" {
    if (result === "1/2-1/2") return "draw";
    return (result === "1-0") === (you === "white") ? "win" : "loss";
}

/** Replay UCI moves; returns FENs (start included) and SANs, stopping at an illegal move. */
export function replay(startFen: string, ucis: string[]): { fens: string[]; sans: string[] } {
    const fens = [startFen];
    const sans: string[] = [];
    for (const u of ucis) {
        const r = playUci(fens[fens.length - 1], u);
        if (!r) break;
        fens.push(r.fen);
        sans.push(r.san);
    }
    return { fens, sans };
}

function fmtClock(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatClock(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** PGN with headers and optional %clk comments (remaining time after each move). */
export function buildPgn(opts: {
    headers: Record<string, string>;
    sans: string[];
    clocksMs?: (number | null)[];
    result: string;
}): string {
    const head = Object.entries(opts.headers)
        .map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`)
        .join("\n");
    const body = opts.sans
        .map((san, i) => {
            const no = i % 2 === 0 ? `${i / 2 + 1}. ` : "";
            const clk = opts.clocksMs?.[i];
            return `${no}${san}${clk != null ? ` {[%clk ${fmtClock(clk)}]}` : ""}`;
        })
        .join(" ");
    return `${head}\n\n${body} ${opts.result}\n`;
}

/** A human-feeling pause before Maia's move (ms): quicker in the opening, random spread. */
export function humanDelay(ply: number, rand: () => number = Math.random): number {
    const base = ply < 10 ? 500 : 900;
    return Math.round(base + rand() * (ply < 10 ? 700 : 1600));
}

/** How many plies a takeback removes so it's your move again. */
export function takebackPlies(
    moveCount: number,
    youAreWhite: boolean,
    maiaThinking: boolean,
): number {
    if (moveCount === 0) return 0;
    const yourTurn = (moveCount % 2 === 0) === youAreWhite;
    if (maiaThinking || !yourTurn) return 1;
    return Math.min(2, moveCount);
}
