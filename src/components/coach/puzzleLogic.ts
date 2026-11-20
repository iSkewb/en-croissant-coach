// Pure rules for themed puzzles (unit-tested in src/utils/tests/puzzleLogic.test.ts).
import type { ThemeStat } from "@/utils/training";
import { playUci, sameMove } from "./drillLogic";

/** Rating window for picking puzzles around your Coach puzzle rating. */
export function ratingWindow(rating: number, width = 150): [number, number] {
    const r = Math.round(rating);
    return [Math.max(400, r - width), Math.min(3200, r + width)];
}

export type PuzzleCheck =
    | { kind: "correct"; fen: string; san: string; finished: boolean }
    | { kind: "wrong"; fen: string; san: string }
    | { kind: "illegal" };

/**
 * Check your move at `moveIdx` (an odd index into `moves`). Any checkmating move is accepted,
 * like on Lichess, even if it differs from the stored solution.
 */
export function checkPuzzleMove(
    fen: string,
    uci: string,
    moves: string[],
    moveIdx: number,
): PuzzleCheck {
    const r = playUci(fen, uci);
    if (!r) return { kind: "illegal" };
    if (sameMove(uci, moves[moveIdx]) || r.mate) {
        const finished = r.mate || moveIdx + 1 >= moves.length;
        return { kind: "correct", fen: r.fen, san: r.san, finished };
    }
    return { kind: "wrong", fen: r.fen, san: r.san };
}

/** Turn "hangingPiece" into "Hanging piece". */
export function themeLabel(theme: string): string {
    const special: Record<string, string> = {
        mateIn1: "Mate in 1",
        mateIn2: "Mate in 2",
        mateIn3: "Mate in 3",
        xRayAttack: "X-ray attack",
    };
    if (special[theme]) return special[theme];
    const words = theme.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "14/20 (70%)" style summary across the given themes. */
export function themeSummary(
    stats: ThemeStat[],
    themes: string[],
): { attempts: number; solved: number; recentAttempts: number; recentSolved: number } {
    const set = new Set(themes);
    return stats
        .filter((s) => set.has(s.theme))
        .reduce(
            (a, s) => ({
                attempts: a.attempts + s.attempts,
                solved: a.solved + s.solved,
                recentAttempts: a.recentAttempts + s.recentAttempts,
                recentSolved: a.recentSolved + s.recentSolved,
            }),
            { attempts: 0, solved: 0, recentAttempts: 0, recentSolved: 0 },
        );
}

export const pct = (solved: number, attempts: number) =>
    attempts === 0 ? "–" : `${Math.round((solved / attempts) * 100)}%`;
