import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const board: { current: any } = { current: null };
vi.mock("@/components/coach/MistakeBoard", () => ({
  MistakeBoard: (p: any) => {
    board.current = p;
    return <div data-testid="board">{p.fen}</div>;
  },
  uciToShape: () => null,
}));
vi.mock("@/components/coach/autoAnalyze", () => ({ pickEngine: () => null }));
vi.mock("@/utils/lichess/api", () => ({
  getTablebaseInfo: async () => {
    throw new Error("offline");
  },
}));
const endgameRecord = vi.fn(async () => [
  { drillId: "t", attempts: 1, successes: 1, cleanDays: 1, lastDate: null },
]);
vi.mock("@/utils/training", async (orig) => ({
  ...(await orig<any>()),
  training: { endgameRecord: (...a: any[]) => endgameRecord(...(a as [])) },
}));

import type { Drill } from "@/components/coach/endgame/curriculum";
import EndgameSession, { type Oracle } from "@/components/coach/endgame/EndgameSession";

// White: Kg6? Simple rook position: Ra1 mates on a8 (back rank), black king h8, white king g6.
const FEN = "7k/8/6K1/8/8/8/8/R7 w - - 0 1";
const drill: Drill = {
  id: "t",
  title: "Test mate",
  summary: "",
  idea: ["Check on the back rank."],
  goal: { kind: "mate", maxMoves: 3 },
  source: { fens: [FEN] },
  positions: 1,
};

// Fake oracle: after a rook move along the 1st rank the defender is lost and plays Kg8;
// a king move that stalemates is handled by the rules; anything else "draws".
const oracle: Oracle = async (fen) => {
  if (fen.startsWith("7k/8/6K1/8/8/8/8/1R6") || fen.startsWith("7k/8/6K1/8/8/8/8/2R5"))
    return { verdict: "loss", best: "h8g8", source: "engine" };
  if (fen.startsWith("6k1/")) return { verdict: "win", best: "b1b8", source: "engine" };
  return { verdict: "draw", best: null, source: "engine" };
};

const sleep = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeAll(() => {
  window.matchMedia ||= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as any;
  (globalThis as any).ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  endgameRecord.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const onFinished = vi.fn();
async function render(d: Drill = drill) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <EndgameSession
          drill={d}
          onExit={() => {}}
          onFinished={onFinished}
          oracle={oracle}
          seed={0}
          replyDelayMs={0}
        />
      </MantineProvider>,
    );
  });
  await sleep(10);
}
const button = (t: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(t),
  ) as HTMLButtonElement;
const move = async (uci: string) => {
  await act(async () => board.current.onMove(uci));
  await sleep(10);
};

test("direct mate solves cleanly and is recorded", async () => {
  await render();
  expect(container.textContent).toContain("You play white. Checkmate in 3 moves or fewer.");
  await move("a1a8");
  expect(container.textContent).toContain("no help needed");
  expect(endgameRecord).toHaveBeenCalledWith(
    { drillId: "t", success: true, clean: true, moves: 1 },
    expect.any(Number),
  );
  expect(onFinished).toHaveBeenCalled();
});

test("a move that loses the win can be taken back; defender replies are played", async () => {
  await render();
  await move("g6g5"); // oracle says draw -> lost the win
  expect(container.textContent).toContain("lets the win slip");
  await act(async () => button("Take back").click());
  expect(board.current.fen).toBe(FEN);
  await move("a1b1"); // keeps the win; defender replies Kg8
  expect(board.current.fen.startsWith("6k1/")).toBe(true);
  await move("b1b8");
  expect(container.textContent).toContain("Next time, try it without help");
  expect(endgameRecord).toHaveBeenCalledWith(
    { drillId: "t", success: true, clean: false, moves: 2 },
    expect.any(Number),
  );
});

test("stalemate fails a mate drill", async () => {
  await render({ ...drill, source: { fens: ["7k/8/6K1/8/8/8/8/5Q2 w - - 0 1"] } });
  await move("f1f7"); // the queen takes every square: stalemate
  expect(container.textContent).toContain("Stalemate");
  expect(button("Take back")).toBeTruthy();
});
