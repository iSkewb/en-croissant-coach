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
  uciToShape: (u: string) => ({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: "green" }),
}));
const repSaveCard = vi.fn(async () => {});
vi.mock("@/utils/training", async (orig) => ({
  ...(await orig<any>()),
  training: { repSaveCard: (...a: any[]) => repSaveCard(...(a as [])) },
}));

import OpeningReview from "@/components/coach/openings/OpeningReview";
import { parseLine, planSession, posKey, sanToUci } from "@/components/coach/openings/repertoire";

const line = parseLine({
  id: 1,
  side: "white",
  name: "London",
  moves: sanToUci("d4 d5 Bf4")!,
  source: "starter",
});
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
  repSaveCard.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const finished = vi.fn();
async function render(cards: any[]) {
  const session = planSession([line], cards, new Date(), { maxPositions: 8, maxNew: 8 });
  await act(async () => {
    root.render(
      <MantineProvider>
        <OpeningReview session={session} cards={cards} onFinished={finished} autoDelayMs={5} />
      </MantineProvider>,
    );
  });
  await sleep(20);
}
const move = async (u: string) => {
  await act(async () => board.current.onMove(u));
  await sleep(30);
};

test("new moves are shown, played, and scheduled", async () => {
  await render([]);
  expect(container.textContent).toContain("Your move here is d4");
  expect(board.current.shapes).toHaveLength(1);
  await move("d2d4");
  // their d5 is auto-played, then Bf4 is new
  expect(container.textContent).toContain("Your move here is Bf4");
  await move("c1f4");
  await sleep(50);
  expect(container.textContent).toContain("Openings reviewed");
  expect(container.textContent).toContain("2 positions practised, 2 new");
  expect(repSaveCard).toHaveBeenCalledTimes(2);
  expect((repSaveCard.mock.calls[0] as any[])[1]).toBe(false);
});

test("a due move played wrong is shown, then counts as a lapse", async () => {
  const past = "2026-01-01T00:00:00.000Z";
  const keyStart = posKey(line.plies[0].fen);
  const keyBf4 = posKey(line.plies[2].fen);
  const future = "2099-01-01T00:00:00.000Z";
  const cards = [
    {
      side: "white",
      posKey: keyStart,
      cardJson: JSON.stringify({
        due: future,
        stability: 3,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 3,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: past,
      }),
      due: future,
    },
    {
      side: "white",
      posKey: keyBf4,
      cardJson: JSON.stringify({
        due: past,
        stability: 3,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 3,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: past,
      }),
      due: past,
    },
  ];
  await render(cards);
  expect(container.textContent).toContain("What do you play here?");
  expect(board.current.shapes).toHaveLength(0);
  await move("d2d4"); // context move, not graded
  expect(repSaveCard).not.toHaveBeenCalled();
  await move("g1f3"); // wrong
  expect(container.textContent).toContain("not your repertoire move");
  expect(board.current.shapes).toHaveLength(1);
  await move("c1f4");
  await sleep(50);
  expect(repSaveCard).toHaveBeenCalledTimes(1);
  expect((repSaveCard.mock.calls[0] as any[])[1]).toBe(true);
  expect(container.textContent).toContain("Openings reviewed");
});
