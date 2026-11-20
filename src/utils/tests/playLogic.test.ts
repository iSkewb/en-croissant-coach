import { describe, expect, test } from "vitest";
import {
    buildPgn,
    formatClock,
    gameEnd,
    humanDelay,
    replay,
    resultFor,
    START_FEN,
    takebackPlies,
    toChessComRapid,
} from "@/components/coach/playLogic";

describe("gameEnd", () => {
    test("checkmate", () => {
        const { fens } = replay(START_FEN, [
            "e2e4",
            "e7e5",
            "f1c4",
            "b8c6",
            "d1h5",
            "g8f6",
            "h5f7",
        ]);
        expect(gameEnd(fens)).toEqual({ result: "1-0", reason: "checkmate" });
    });
    test("threefold repetition", () => {
        const { fens } = replay(START_FEN, [
            "g1f3",
            "g8f6",
            "f3g1",
            "f6g8",
            "g1f3",
            "g8f6",
            "f3g1",
            "f6g8",
        ]);
        expect(gameEnd(fens)?.reason).toBe("threefold repetition");
        expect(gameEnd(fens.slice(0, 5))).toBeNull();
    });
    test("insufficient material and stalemate", () => {
        expect(gameEnd(["8/8/8/4k3/8/8/4K3/8 w - - 0 60"])?.reason).toBe("insufficient material");
        expect(gameEnd(["7k/5Q2/6K1/8/8/8/8/8 b - - 0 60"])?.reason).toBe("stalemate");
    });
    test("ongoing game", () => {
        expect(gameEnd([START_FEN])).toBeNull();
    });
});

test("resultFor", () => {
    expect(resultFor("1-0", "white")).toBe("win");
    expect(resultFor("1-0", "black")).toBe("loss");
    expect(resultFor("1/2-1/2", "black")).toBe("draw");
});

test("buildPgn with clocks parses back", () => {
    const pgn = buildPgn({
        headers: { White: "You", Black: "Maia-3 1100", Result: "1-0" },
        sans: ["e4", "e5", "Qh5"],
        clocksMs: [599_000, 598_500, 3_661_000],
        result: "1-0",
    });
    expect(pgn).toContain('[White "You"]');
    expect(pgn).toContain("1. e4 {[%clk 0:09:59]} e5 {[%clk 0:09:59]} 2. Qh5 {[%clk 1:01:01]} 1-0");
});

test("helpers", () => {
    expect(formatClock(61_000)).toBe("1:01");
    expect(toChessComRapid(1100)).toBe(750);
    const d = humanDelay(4, () => 0.5);
    expect(d).toBeGreaterThan(400);
    expect(humanDelay(30, () => 1)).toBeLessThanOrEqual(2500);
});

test("takebackPlies", () => {
    // you are white, it's your move again after Maia replied: undo both
    expect(takebackPlies(2, true, false)).toBe(2);
    // Maia still thinking about its reply: undo just your move
    expect(takebackPlies(1, true, true)).toBe(1);
    // you are black, Maia (white) opened and it's your move: only Maia's move exists
    expect(takebackPlies(1, false, false)).toBe(1);
    expect(takebackPlies(0, true, false)).toBe(0);
});
