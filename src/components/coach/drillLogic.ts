// Pure rules for interactive drills (unit-tested in src/utils/tests/drillLogic.test.ts).
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { positionFromFen } from "@/utils/chessops";
import { getWinChance } from "@/utils/score";

export type MoveGrade = "best" | "excellent" | "good" | "inaccurate" | "wrong";

/** Win-chance points (0–100) you may lose versus the best move and still get credit. */
export const EXCELLENT_MAX_DROP = 3;
export const GOOD_MAX_DROP = 8;
export const INACCURATE_MAX_DROP = 15;

/** Grade a move by comparing its eval with the best eval, both from the mover's view (cp). */
export function gradeMove(bestCp: number, moveCp: number): { grade: MoveGrade; drop: number } {
    const drop = Math.max(0, getWinChance(bestCp) - getWinChance(moveCp));
    const grade: MoveGrade =
        drop <= EXCELLENT_MAX_DROP
            ? "excellent"
            : drop <= GOOD_MAX_DROP
              ? "good"
              : drop <= INACCURATE_MAX_DROP
                ? "inaccurate"
                : "wrong";
    return { grade, drop };
}

export function isAccepted(g: MoveGrade): boolean {
    return g === "best" || g === "excellent" || g === "good";
}

export const GRADE_LABEL: Record<MoveGrade, string> = {
    best: "Best move",
    excellent: "Excellent",
    good: "Good",
    inaccurate: "Inaccurate",
    wrong: "Mistake",
};

export const GRADE_COLOR: Record<MoveGrade, string> = {
    best: "teal",
    excellent: "green",
    good: "lime",
    inaccurate: "orange",
    wrong: "red",
};

const POSITIONAL_ONLY = new Set([
    "positional",
    "was_winning",
    "was_losing",
    "time_pressure",
    "rushed",
]);

/**
 * How many of your moves a drill asks for. Tactical mistakes are played out so the idea
 * is finished (e.g. the fork actually wins the piece); positional ones stop after one move.
 */
export function movesToPlay(tags: string[]): number {
    if (tags.includes("missed_mate")) return 4;
    const tactical = tags.some((t) => !POSITIONAL_ONLY.has(t));
    return tactical ? 3 : 1;
}

/** Spaced-repetition outcome for the whole drill. */
export function drillOutcome(opts: {
    grades: MoveGrade[];
    hints: number;
    failedAttempts: number;
    revealed: boolean;
}): "correct" | "correct_with_hint" | "wrong" {
    if (opts.revealed || opts.grades.length === 0) return "wrong";
    const flawless = opts.grades.every((g) => g === "best" || g === "excellent");
    if (flawless && opts.hints === 0 && opts.failedAttempts === 0) return "correct";
    return "correct_with_hint";
}

/** Play a UCI move on a FEN. Returns null if illegal. */
export function playUci(
    fen: string,
    uci: string,
): { fen: string; san: string; mate: boolean; over: boolean } | null {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci);
    if (!pos || !move || !pos.isLegal(move)) return null;
    const san = makeSan(pos, move);
    pos.play(move);
    return {
        fen: makeFen(pos.toSetup()),
        san,
        mate: pos.isCheckmate(),
        over: pos.isEnd(),
    };
}

/** Same move? Treats promotion-less matches as equal (we auto-queen in drills). */
export function sameMove(a: string | undefined | null, b: string | undefined | null): boolean {
    if (!a || !b) return false;
    return a === b || (a.slice(0, 4) === b.slice(0, 4) && (a.length === 4 || b.length === 4));
}
