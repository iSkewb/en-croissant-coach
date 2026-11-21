import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/components/coach/MistakeBoard", () => ({
  MistakeBoard: () => null,
  uciToShape: () => null,
}));
vi.mock("@/components/coach/autoAnalyze", () => ({ pickEngine: () => null }));
let lines: any[] = [];
let cards: any[] = [];
let games: any[] = [];
const repSaveLine = vi.fn(async (l: any) => {
  lines.push({ ...l, id: lines.length + 1 });
  return lines.length;
});
const repSaveCard = vi.fn(async () => {});
vi.mock("@/utils/training", async (orig) => ({
  ...(await orig<any>()),
  training: {
    repLines: async () => [...lines],
    repCards: async () => cards,
    repGames: async () => games,
    repSaveLine: (l: any) => repSaveLine(l),
    repSaveCard: (...a: any[]) => repSaveCard(...(a as [])),
    repDeleteLine: async () => {},
  },
}));

import OpeningsPage from "@/components/coach/openings/OpeningsPage";
import { sanToUci } from "@/components/coach/openings/repertoire";
import { STARTERS } from "@/components/coach/openings/starters";

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
  lines = [];
  cards = [];
  games = [];
  localStorage.clear();
  repSaveLine.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <OpeningsPage />
      </MantineProvider>,
    );
  });
  await sleep(30);
}
const button = (t: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(t),
  ) as HTMLButtonElement;

test("first visit offers the starters and imports every line", async () => {
  await render();
  expect(container.textContent).toContain("London System");
  expect(container.textContent).toContain("Scandinavian: 3...Qa5");
  await act(async () => button("Add them").click());
  await sleep(30);
  const total = STARTERS.reduce((n, s) => n + s.lines.length, 0);
  expect(repSaveLine).toHaveBeenCalledTimes(total);
  expect(container.textContent).toMatch(/0 due · \d+ new/);
  expect(container.textContent).toContain("London System: Main line");
});

test("games show gaps and deviations", async () => {
  lines = [
    { id: 1, side: "white", name: "London", moves: sanToUci("d4 d5 Bf4 Nf6 e3")!, source: "mine" },
  ];
  games = [
    {
      gameId: "a",
      color: "black",
      movesUci: sanToUci("d4 d5 c4 e6")!,
      date: "2026-11-10",
      opponent: "bob",
      url: null,
    },
    {
      gameId: "b",
      color: "white",
      movesUci: sanToUci("d4 d5 Nf3 Nf6")!,
      date: "2026-11-11",
      opponent: "ann",
      url: null,
    },
  ];
  await render();
  expect(container.textContent).toContain("Not in your repertoire yet");
  expect(container.textContent).toContain("After 1.d4");
  expect(container.textContent).toContain(
    "vs ann (2026-11-11): move 2, you played Nf3, your repertoire says Bf4",
  );
  await act(async () => button("Add a reply").click());
  expect(container.textContent).toContain("Add a reply: after 1.d4");
});
