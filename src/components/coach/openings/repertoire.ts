// Pure repertoire logic: lines → a "book" of positions, review sessions, and how your
// real games compare with the book. Unit-tested.
import { makeUci, parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { RepCard, RepGame, RepLine } from "@/utils/training";

export type Side = "white" | "black";
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Placement, side to move, castling, en passant: the same position however you got there. */
export const posKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

export type Ply = {
    uci: string;
    san: string;
    /** Position before this move. */
    fen: string;
    key: string;
    by: "you" | "them";
    /** 1-based move number, for display. */
    moveNo: number;
};

export type ParsedLine = { line: RepLine; plies: Ply[]; error: string | null };

export function parseLine(line: RepLine): ParsedLine {
    const pos = Chess.default();
    const plies: Ply[] = [];
    const moves = line.moves.trim() ? line.moves.trim().split(/\s+/) : [];
    for (let i = 0; i < moves.length; i++) {
        const m = parseUci(moves[i]);
        if (!m || !pos.isLegal(m)) return { line, plies, error: `Illegal move ${moves[i]}` };
        const fen = makeFen(pos.toSetup());
        const by = (pos.turn === "white") === (line.side === "white") ? "you" : "them";
        plies.push({
            uci: moves[i],
            san: makeSan(pos, m),
            fen,
            key: posKey(fen),
            by,
            moveNo: Math.floor(i / 2) + 1,
        });
        pos.play(m);
    }
    return { line, plies, error: null };
}

/** "e4 e5 Nf3" (SAN, from the start) → UCI moves; null if any move is illegal. */
export function sanToUci(san: string): string | null {
    const pos = Chess.default();
    const out: string[] = [];
    for (const s of san.trim().split(/\s+/)) {
        const m = parseSan(pos, s);
        if (!m) return null;
        out.push(makeUci(m));
        pos.play(m);
    }
    return out.join(" ");
}

/** "1.d4 d5 2.Bf4" style text. */
export function movesText(plies: { san: string }[], startPly = 0): string {
    return plies
        .map((p, k) => {
            const i = startPly + k;
            return i % 2 === 0
                ? `${i / 2 + 1}.${p.san}`
                : k === 0
                  ? `${Math.floor(i / 2) + 1}...${p.san}`
                  : p.san;
        })
        .join(" ");
}

export type BookEntry = {
    key: string;
    fen: string;
    /** Your move here (when it's your turn). */
    yours: { uci: string; san: string } | null;
    /** Other moves of yours found in other lines for the same position (a conflict). */
    conflicts: string[];
    /** Their replies covered by your lines (when it's their turn). */
    theirs: Map<string, string>;
    lineIds: Set<number>;
    ply: number;
};

export type Book = Map<string, BookEntry>;

export function buildBook(lines: ParsedLine[], side: Side): Book {
    const book: Book = new Map();
    for (const pl of lines) {
        if (pl.line.side !== side) continue;
        pl.plies.forEach((p, i) => {
            let e = book.get(p.key);
            if (!e) {
                e = {
                    key: p.key,
                    fen: p.fen,
                    yours: null,
                    conflicts: [],
                    theirs: new Map(),
                    lineIds: new Set(),
                    ply: i,
                };
                book.set(p.key, e);
            }
            if (pl.line.id !== null) e.lineIds.add(pl.line.id);
            if (p.by === "you") {
                if (!e.yours) e.yours = { uci: p.uci, san: p.san };
                else if (e.yours.uci !== p.uci && !e.conflicts.includes(p.san))
                    e.conflicts.push(p.san);
            } else e.theirs.set(p.uci, p.san);
        });
    }
    return book;
}

export const yourPositions = (book: Book) => [...book.values()].filter((e) => e.yours);

// ---------- scheduling ----------

export type CardState = "new" | "due" | "later";

export function cardState(card: RepCard | undefined, now: Date): CardState {
    if (!card) return "new";
    return new Date(card.due).getTime() <= now.getTime() ? "due" : "later";
}

export const cardMap = (cards: RepCard[], side: Side) =>
    new Map(cards.filter((c) => c.side === side).map((c) => [c.posKey, c]));

export function counts(lines: ParsedLine[], cards: RepCard[], now: Date) {
    let due = 0;
    let fresh = 0;
    let total = 0;
    for (const side of ["white", "black"] as const) {
        const cm = cardMap(cards, side);
        for (const e of yourPositions(buildBook(lines, side))) {
            total++;
            const s = cardState(cm.get(e.key), now);
            if (s === "due") due++;
            if (s === "new") fresh++;
        }
    }
    return { due, fresh, total };
}

export type SessionLine = {
    parsed: ParsedLine;
    /** Play the line up to and including this ply. */
    endPly: number;
    /** Positions (keys) graded in this line. */
    graded: Set<string>;
};

/**
 * Choose lines to replay so the due positions (most overdue first), then up to `maxNew`
 * new ones (shallowest first), get practised, at most `maxPositions` in all.
 */
export function planSession(
    lines: ParsedLine[],
    cards: RepCard[],
    now: Date,
    opts: { maxPositions: number; maxNew: number },
): SessionLine[] {
    type Target = { side: Side; key: string; order: number; isNew: boolean };
    const targets: Target[] = [];
    for (const side of ["white", "black"] as const) {
        const cm = cardMap(cards, side);
        const entries = yourPositions(buildBook(lines, side));
        for (const e of entries) {
            const c = cm.get(e.key);
            const s = cardState(c, now);
            if (s === "due")
                targets.push({ side, key: e.key, order: new Date(c!.due).getTime(), isNew: false });
            if (s === "new")
                targets.push({
                    side,
                    key: e.key,
                    order: Number.MAX_SAFE_INTEGER - 1e6 + e.ply,
                    isNew: true,
                });
        }
    }
    targets.sort((a, b) => a.order - b.order);
    const chosen: Target[] = [];
    let newCount = 0;
    for (const t of targets) {
        if (chosen.length >= opts.maxPositions) break;
        if (t.isNew) {
            if (newCount >= opts.maxNew) continue;
            newCount++;
        }
        chosen.push(t);
    }

    const session: SessionLine[] = [];
    const covered = new Set<string>();
    const sideKey = (side: Side, key: string) => `${side}|${key}`;
    for (const t of chosen) {
        if (covered.has(sideKey(t.side, t.key))) continue;
        // The line through this position that practises the most chosen positions (then the shortest).
        let best: { pl: ParsedLine; idx: number; score: number } | null = null;
        for (const pl of lines) {
            if (pl.line.side !== t.side || pl.error) continue;
            const idx = pl.plies.findIndex((p) => p.key === t.key && p.by === "you");
            if (idx < 0) continue;
            const score = pl.plies.filter(
                (p) =>
                    p.by === "you" &&
                    !covered.has(sideKey(t.side, p.key)) &&
                    chosen.some((c) => c.side === t.side && c.key === p.key),
            ).length;
            if (
                !best ||
                score > best.score ||
                (score === best.score && pl.plies.length < best.pl.plies.length)
            )
                best = { pl, idx, score };
        }
        if (!best) continue;
        // Grade every chosen target on this line; stop after the last one.
        const graded = new Set<string>();
        let endPly = best.idx;
        best.pl.plies.forEach((p, i) => {
            const k = sideKey(t.side, p.key);
            if (
                p.by === "you" &&
                chosen.some((c) => sideKey(c.side, c.key) === k) &&
                !covered.has(k)
            ) {
                graded.add(p.key);
                covered.add(k);
                endPly = Math.max(endPly, i);
            }
        });
        session.push({ parsed: best.pl, endPly, graded });
    }
    return session;
}

// ---------- your games vs the book ----------

export type GameCheck =
    | { kind: "followed"; yourMoves: number }
    | {
          kind: "deviated";
          yourMoves: number;
          ply: number;
          key: string;
          fen: string;
          played: string;
          expected: string;
      }
    | {
          kind: "gap";
          yourMoves: number;
          ply: number;
          key: string;
          fen: string;
          prefix: string[];
          lastSan: string | null;
      };

/** Walk a game against your book for the side you played. */
export function checkGame(book: Book, side: Side, movesUci: string[], maxPly = 24): GameCheck {
    const pos = Chess.default();
    let yourMoves = 0;
    let prevInBook = true; // the start position always counts as "in book"
    for (let i = 0; i < Math.min(movesUci.length, maxPly); i++) {
        const fen = makeFen(pos.toSetup());
        const key = posKey(fen);
        const entry = book.get(key);
        const m = parseUci(movesUci[i]);
        if (!m || !pos.isLegal(m)) break;
        if (pos.turn === side) {
            if (!entry?.yours) {
                if (!prevInBook) return { kind: "followed", yourMoves };
                const last = i > 0 ? lastSan(movesUci.slice(0, i)) : null;
                return {
                    kind: "gap",
                    yourMoves,
                    ply: i,
                    key,
                    fen,
                    prefix: movesUci.slice(0, i),
                    lastSan: last,
                };
            }
            if (movesUci[i] !== entry.yours.uci)
                return {
                    kind: "deviated",
                    yourMoves,
                    ply: i,
                    key,
                    fen,
                    played: makeSan(pos, m),
                    expected: entry.yours.san,
                };
            yourMoves++;
        }
        prevInBook = i === 0 && side === "black" ? true : !!entry;
        pos.play(m);
    }
    return { kind: "followed", yourMoves };
}

function lastSan(uci: string[]): string {
    const pos = Chess.default();
    let san = "";
    for (const u of uci) {
        const m = parseUci(u)!;
        san = makeSan(pos, m);
        pos.play(m);
    }
    return san;
}

export type Gap = {
    side: Side;
    key: string;
    fen: string;
    prefix: string[];
    label: string;
    games: number;
};
export type Deviation = {
    side: Side;
    game: RepGame;
    key: string;
    played: string;
    expected: string;
    moveNo: number;
};

export type Coverage = {
    games: number;
    avgYourMoves: number;
    gaps: Gap[];
    deviations: Deviation[];
};

export function coverage(lines: ParsedLine[], games: RepGame[]): Coverage {
    const books = { white: buildBook(lines, "white"), black: buildBook(lines, "black") };
    const gaps = new Map<string, Gap>();
    const deviations: Deviation[] = [];
    let sum = 0;
    for (const g of games) {
        const side = g.color;
        const moves = g.movesUci.trim().split(/\s+/);
        const r = checkGame(books[side], side, moves);
        sum += r.yourMoves;
        if (r.kind === "gap") {
            const id = `${side}|${r.key}`;
            const label = r.prefix.length
                ? `After ${movesText(sanList(r.prefix))}`
                : "Your first move";
            const cur = gaps.get(id);
            if (cur) cur.games++;
            else gaps.set(id, { side, key: r.key, fen: r.fen, prefix: r.prefix, label, games: 1 });
        }
        if (r.kind === "deviated")
            deviations.push({
                side,
                game: g,
                key: r.key,
                played: r.played,
                expected: r.expected,
                moveNo: Math.floor(r.ply / 2) + 1,
            });
    }
    return {
        games: games.length,
        avgYourMoves: games.length ? sum / games.length : 0,
        gaps: [...gaps.values()].sort(
            (a, b) => b.games - a.games || a.prefix.length - b.prefix.length,
        ),
        deviations,
    };
}

export function sanList(uci: string[]): { san: string }[] {
    const pos = Chess.default();
    return uci.map((u) => {
        const m = parseUci(u)!;
        const san = makeSan(pos, m);
        pos.play(m);
        return { san };
    });
}

/** FEN after playing `uci` moves from the start. */
export function fenAfter(uci: string[]): string {
    const pos = Chess.default();
    for (const u of uci) pos.play(parseUci(u)!);
    return makeFen(pos.toSetup());
}
