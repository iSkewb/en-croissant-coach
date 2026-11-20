import { expect, test } from "vitest";
import {
    coverage,
    findCriticalMoments,
    type MainlinePoint,
    moveLabel,
} from "@/components/panels/coach/criticalMoments";

const W = "w KQkq - 0 1";
const B = "b KQkq - 0 1";
// fen only needs the side-to-move field for these tests
function p(i: number, san: string | null, whiteCp: number | null): MainlinePoint {
    return {
        position: Array(i).fill(0),
        fen: `x ${i % 2 === 0 ? W : B}`,
        san,
        halfMoves: i,
        whiteCp,
    };
}

const line: MainlinePoint[] = [
    p(0, null, 30),
    p(1, "e4", 35), // white fine
    p(2, "e5", 40),
    p(3, "Nf3", 30),
    p(4, "Qh4", 350), // black blunders (white +3.5)
    p(5, "Nxh4", 360),
    p(6, "d6", 380),
    p(7, "Qe2", -50), // white throws it away
    p(8, "Bg4", -60),
    p(9, "h3", -250), // white slips further
];

test("finds swings for both sides, biggest first", () => {
    const ms = findCriticalMoments(line);
    expect(ms.map((m) => m.san)).toEqual(["Qe2", "Qh4", "h3"]);
    const black = ms.find((m) => m.san === "Qh4")!;
    expect(black.color).toBe("black");
    expect(black.severity).toBe("blunder");
    expect(black.beforePosition).toEqual([0, 0, 0]);
    expect(black.afterPosition).toEqual([0, 0, 0, 0]);
    expect(moveLabel(black)).toBe("2... Qh4");
    expect(moveLabel(ms[0])).toBe("4. Qe2");
});

test("can filter to one side and limit", () => {
    expect(findCriticalMoments(line, { color: "black" }).map((m) => m.san)).toEqual(["Qh4"]);
    expect(findCriticalMoments(line, { limit: 1 })).toHaveLength(1);
});

test("skips positions without evaluations", () => {
    const partial = line.map((x, i) => (i === 4 ? { ...x, whiteCp: null } : x));
    expect(findCriticalMoments(partial).map((m) => m.san)).not.toContain("Qh4");
    expect(coverage(partial)).toBeCloseTo(8 / 9);
});
