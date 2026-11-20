import { describe, expect, test } from "vitest";
import {
    checkPuzzleMove,
    pct,
    ratingWindow,
    themeLabel,
    themeSummary,
} from "@/components/coach/puzzleLogic";

describe("checkPuzzleMove", () => {
    // Back-rank: white to move, Ra8# (solution stored as a1a8).
    const fen = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
    test("stored solution is correct and finishes a 2-move line", () => {
        const r = checkPuzzleMove(fen, "a1a8", ["x", "a1a8"], 1);
        expect(r).toMatchObject({ kind: "correct", san: "Ra8#", finished: true });
    });
    test("a different legal move is wrong", () => {
        expect(checkPuzzleMove(fen, "a1a2", ["x", "a1a8"], 1).kind).toBe("wrong");
    });
    test("an alternative checkmate is accepted", () => {
        // stored solution is something else, but Ra8 mates
        const r = checkPuzzleMove(fen, "a1a8", ["x", "g1h1", "y", "z"], 1);
        expect(r).toMatchObject({ kind: "correct", finished: true });
    });
    test("non-final correct move does not finish", () => {
        const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        const r = checkPuzzleMove(start, "e2e4", ["x", "e2e4", "e7e5", "g1f3"], 1);
        expect(r).toMatchObject({ kind: "correct", finished: false });
    });
    test("illegal move", () => {
        expect(checkPuzzleMove(fen, "a1h8", ["x", "a1a8"], 1).kind).toBe("illegal");
    });
});

test("ratingWindow clamps and centres", () => {
    expect(ratingWindow(1500)).toEqual([1350, 1650]);
    expect(ratingWindow(450)).toEqual([400, 600]);
});

test("themeLabel", () => {
    expect(themeLabel("hangingPiece")).toBe("Hanging piece");
    expect(themeLabel("mateIn2")).toBe("Mate in 2");
    expect(themeLabel("fork")).toBe("Fork");
});

test("themeSummary sums only the requested themes", () => {
    const stats = [
        { theme: "fork", attempts: 10, solved: 7, recentAttempts: 4, recentSolved: 4 },
        { theme: "pin", attempts: 5, solved: 1, recentAttempts: 0, recentSolved: 0 },
        { theme: "hangingPiece", attempts: 2, solved: 1, recentAttempts: 2, recentSolved: 1 },
    ];
    expect(themeSummary(stats, ["fork", "hangingPiece"])).toEqual({
        attempts: 12,
        solved: 8,
        recentAttempts: 6,
        recentSolved: 5,
    });
    expect(pct(8, 12)).toBe("67%");
    expect(pct(0, 0)).toBe("–");
});
