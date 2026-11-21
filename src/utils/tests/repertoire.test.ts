import { describe, expect, test } from "vitest";
import {
    buildBook,
    checkGame,
    counts,
    coverage,
    movesText,
    parseLine,
    planSession,
    sanToUci,
    yourPositions,
} from "@/components/coach/openings/repertoire";
import { STARTERS } from "@/components/coach/openings/starters";
import type { RepCard, RepGame, RepLine } from "@/utils/training";

const line = (id: number, side: "white" | "black", san: string): RepLine => ({
    id,
    side,
    name: `L${id}`,
    moves: sanToUci(san)!,
    source: "mine",
});
const london = [
    line(1, "white", "d4 d5 Bf4 Nf6 e3 e6 Nf3"),
    line(2, "white", "d4 d5 Bf4 c5 e3 Nc6 c3"),
    line(3, "white", "d4 Nf6 Bf4 g6 e3"),
];
const scandi = [line(4, "black", "e4 d5 exd5 Qxd5 Nc3 Qa5")];
const parsed = [...london, ...scandi].map(parseLine);
const card = (side: "white" | "black", posKey: string, due: string): RepCard => ({
    side,
    posKey,
    cardJson: "{}",
    due,
});
const now = new Date("2026-11-20T12:00:00Z");

test("every starter line is legal and ends on your move", () => {
    for (const st of STARTERS)
        for (const l of st.lines) {
            const uci = sanToUci(l.san);
            expect(uci, l.name).not.toBeNull();
            const p = parseLine({
                id: 0,
                side: st.side,
                name: l.name,
                moves: uci!,
                source: "starter",
            });
            expect(p.error).toBeNull();
            expect(p.plies.at(-1)!.by, l.name).toBe("you");
        }
});

test("starter books have no conflicting moves for the same position", () => {
    for (const st of STARTERS) {
        const lines = st.lines.map((l, k) =>
            parseLine({
                id: k,
                side: st.side,
                name: l.name,
                moves: sanToUci(l.san)!,
                source: "starter",
            }),
        );
        const conflicts = yourPositions(buildBook(lines, st.side)).filter(
            (e) => e.conflicts.length,
        );
        expect(conflicts.map((c) => `${c.fen}: ${c.yours!.san} vs ${c.conflicts}`)).toEqual([]);
    }
});

describe("book", () => {
    const book = buildBook(parsed, "white");
    test("shared positions merge; replies are collected", () => {
        const first = yourPositions(book).find((e) => e.ply === 0)!;
        expect(first.yours!.san).toBe("d4");
        expect(first.lineIds.size).toBe(3);
        const afterD4 = [...book.values()].find((e) => e.ply === 1)!;
        expect([...afterD4.theirs.values()].sort()).toEqual(["Nf6", "d5"]);
        // 1.d4 d5 2.Bf4 is one position for lines 1 and 2: White's moves = d4, Bf4, Bf4(Nf6 line), e3 x2, Nf3, c3, ...
        expect(yourPositions(book).length).toBe(8);
    });
    test("conflicts are reported", () => {
        const b = buildBook([...parsed, parseLine(line(9, "white", "d4 d5 c4"))], "white");
        expect(yourPositions(b).find((e) => e.conflicts.length)?.conflicts).toEqual(["c4"]);
    });
    test("move text", () => {
        expect(movesText(parsed[0].plies.slice(0, 3))).toBe("1.d4 d5 2.Bf4");
        expect(movesText(parsed[0].plies.slice(1, 3), 1)).toBe("1...d5 2.Bf4");
    });
});

describe("sessions", () => {
    test("new positions shallowest first, limited", () => {
        const s = planSession(parsed, [], now, { maxPositions: 8, maxNew: 3 });
        const graded = s.reduce((n, l) => n + l.graded.size, 0);
        expect(graded).toBe(3);
        // 1.d4 (white) and 1...d5 (black) are the shallowest
        expect(s.map((l) => l.parsed.line.side).sort()).toEqual(["black", "white"]);
    });
    test("due before new; lines end at the last graded move", () => {
        const book = buildBook(parsed, "white");
        const deep = yourPositions(book).find((e) => e.yours!.san === "Nf3")!;
        const cards = yourPositions(book).map((e) =>
            card("white", e.key, e === deep ? "2026-11-19T00:00:00Z" : "2026-12-30T00:00:00Z"),
        );
        const s = planSession(
            parsed.filter((p) => p.line.side === "white"),
            cards,
            now,
            { maxPositions: 1, maxNew: 5 },
        );
        expect(s).toHaveLength(1);
        expect(s[0].parsed.line.id).toBe(1);
        expect(s[0].graded.has(deep.key)).toBe(true);
        expect(s[0].parsed.plies[s[0].endPly].san).toBe("Nf3");
    });
    test("counts", () => {
        expect(counts(parsed, [], now)).toEqual({ due: 0, fresh: 11, total: 11 });
    });
});

describe("your games", () => {
    const book = buildBook(parsed, "white");
    const uci = (san: string) => sanToUci(san)!.split(" ");
    test("followed, deviated, gap", () => {
        expect(checkGame(book, "white", uci("d4 d5 Bf4 Nf6 e3 e6 Nf3 c5"))).toEqual({
            kind: "followed",
            yourMoves: 4,
        });
        const dev = checkGame(book, "white", uci("d4 d5 Bf4 Nf6 Nf3"));
        expect(dev).toMatchObject({
            kind: "deviated",
            played: "Nf3",
            expected: "e3",
            yourMoves: 2,
        });
        const gap = checkGame(book, "white", uci("d4 d5 Bf4 Bf5 e3"));
        expect(gap).toMatchObject({ kind: "gap", lastSan: "Bf5", yourMoves: 2, ply: 4 });
    });
    test("as black: no reply to 1.d4 is a gap", () => {
        const b = buildBook(parsed, "black");
        expect(checkGame(b, "black", uci("d4 d5"))).toMatchObject({
            kind: "gap",
            ply: 1,
            lastSan: "d4",
        });
        expect(checkGame(b, "black", uci("e4 d5 exd5 Qxd5 Nc3 Qa5 d4"))).toEqual({
            kind: "followed",
            yourMoves: 3,
        });
    });
    test("coverage groups gaps by position", () => {
        const g = (id: string, color: "white" | "black", san: string): RepGame => ({
            gameId: id,
            color,
            movesUci: sanToUci(san)!,
            date: "2026-11-10",
            opponent: "x",
            url: null,
        });
        const c = coverage(parsed, [
            g("a", "black", "d4 d5 c4"),
            g("b", "black", "d4 Nf6 c4"),
            g("c", "white", "d4 d5 Bf4 Bf5 e3"),
            g("d", "white", "d4 d5 Nf3"),
        ]);
        expect(c.gaps[0]).toMatchObject({ side: "black", label: "After 1.d4", games: 2 });
        expect(c.gaps[1].label).toBe("After 1.d4 d5 2.Bf4 Bf5");
        expect(c.deviations).toHaveLength(1);
        expect(c.deviations[0]).toMatchObject({ played: "Nf3", expected: "Bf4", moveNo: 2 });
    });
});
