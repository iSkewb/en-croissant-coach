// Find the biggest evaluation swings in a game's mainline (unit-tested in
// src/utils/tests/criticalMoments.test.ts).
import { getWinChance } from "@/utils/score";

export type MainlinePoint = {
    /** Path in the game tree (for goToMove). */
    position: number[];
    fen: string;
    /** SAN of the move that led to this position (null for the start). */
    san: string | null;
    halfMoves: number;
    /** Evaluation of this position from White's view, in centipawns (mate mapped to ±1000). */
    whiteCp: number | null;
};

export type CriticalMoment = {
    /** Index in the mainline of the position *after* the bad move. */
    index: number;
    /** Path of the position before the move (where you'd have to find the better move). */
    beforePosition: number[];
    /** Path of the position after the move. */
    afterPosition: number[];
    moveNumber: number;
    color: "white" | "black";
    san: string;
    /** Win-chance points the mover lost (0–100). */
    drop: number;
    severity: "blunder" | "mistake" | "inaccuracy";
    /** Mover's eval before / after, centipawns from the mover's view. */
    beforeCp: number;
    afterCp: number;
};

export function moverOf(fenBefore: string): "white" | "black" {
    return fenBefore.split(" ")[1] === "b" ? "black" : "white";
}

/**
 * Swings where the side that moved lost at least `minDrop` win-chance points,
 * biggest first, at most `limit`. Positions without an evaluation are skipped.
 */
export function findCriticalMoments(
    line: MainlinePoint[],
    opts: { limit?: number; minDrop?: number; color?: "white" | "black" | null } = {},
): CriticalMoment[] {
    const { limit = 5, minDrop = 8, color = null } = opts;
    const out: CriticalMoment[] = [];
    for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1];
        const cur = line[i];
        if (prev.whiteCp == null || cur.whiteCp == null || !cur.san) continue;
        const mover = moverOf(prev.fen);
        if (color && mover !== color) continue;
        const sign = mover === "white" ? 1 : -1;
        const beforeCp = prev.whiteCp * sign;
        const afterCp = cur.whiteCp * sign;
        const drop = getWinChance(beforeCp) - getWinChance(afterCp);
        if (drop < minDrop) continue;
        out.push({
            index: i,
            beforePosition: prev.position,
            afterPosition: cur.position,
            moveNumber: Math.floor(prev.halfMoves / 2) + 1,
            color: mover,
            san: cur.san,
            drop,
            severity: drop > 20 ? "blunder" : drop > 10 ? "mistake" : "inaccuracy",
            beforeCp,
            afterCp,
        });
    }
    return out.sort((a, b) => b.drop - a.drop).slice(0, limit);
}

/** Display like "12. Nxe5" or "12... Qg5". */
export function moveLabel(m: Pick<CriticalMoment, "moveNumber" | "color" | "san">): string {
    return `${m.moveNumber}${m.color === "white" ? "." : "..."} ${m.san}`;
}

/** Share of mainline positions (excluding the final one) that have an evaluation. */
export function coverage(line: MainlinePoint[]): number {
    const n = Math.max(1, line.length - 1);
    return line.slice(0, -1).filter((p) => p.whiteCp != null).length / n;
}
