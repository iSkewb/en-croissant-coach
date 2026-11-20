import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { MistakeBoard } from "@/components/coach/MistakeBoard";

// Regression test: the drill board starts non-interactive (loading / lead-in animation) and
// becomes interactive later. Chessground only binds its mousedown handler at creation time,
// so the board must never be created view-only.
beforeAll(() => {
  window.matchMedia ||= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as any;
  (globalThis as any).ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  vi.restoreAllMocks();
});

test("board created without onMove still binds input handlers", async () => {
  const added: string[] = [];
  const orig = HTMLElement.prototype.addEventListener;
  vi.spyOn(HTMLElement.prototype, "addEventListener").mockImplementation(function (
    this: HTMLElement,
    type: string,
    ...rest: any[]
  ) {
    if (this.tagName === "CG-BOARD") added.push(type);
    return (orig as any).call(this, type, ...rest);
  });

  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  await act(async () => {
    root!.render(
      <MantineProvider>
        <MistakeBoard fen={fen} orientation="white" />
      </MantineProvider>,
    );
  });
  // Later the drill becomes interactive.
  await act(async () => {
    root!.render(
      <MantineProvider>
        <MistakeBoard fen={fen} orientation="white" onMove={() => {}} />
      </MantineProvider>,
    );
  });
  expect(added).toContain("mousedown");
  expect(added).toContain("touchstart");
});
