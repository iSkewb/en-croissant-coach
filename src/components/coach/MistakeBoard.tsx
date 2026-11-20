import { Box } from "@mantine/core";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { makeSquare, parseSquare, parseUci } from "chessops";
import { chessgroundDests } from "chessops/compat";
import { Chessground } from "@/chessground/Chessground";
import classes from "@/styles/Chessboard.module.css";
import { positionFromFen } from "@/utils/chessops";

export function uciToShape(uci: string, brush: string): DrawShape | null {
  const m = parseUci(uci);
  if (!m || !("from" in m)) return null;
  return { orig: makeSquare(m.from) as Key, dest: makeSquare(m.to) as Key, brush };
}

/** A board for one mistake position. Interactive when `onMove` is given. */
export function MistakeBoard({
  fen,
  orientation,
  shapes = [],
  onMove,
  highlightSquare,
  lastMove,
  size = 420,
}: {
  fen: string;
  orientation: "white" | "black";
  shapes?: DrawShape[];
  onMove?: (uci: string) => void;
  highlightSquare?: string | null;
  /** UCI of the move that led to this position (highlighted). */
  lastMove?: string | null;
  size?: number;
}) {
  const [pos] = positionFromFen(fen);
  const dests = pos && onMove ? chessgroundDests(pos) : new Map();
  const turn = pos?.turn ?? "white";
  const allShapes: DrawShape[] = [
    ...shapes,
    ...(highlightSquare ? [{ orig: highlightSquare as Key, brush: "yellow" }] : []),
  ];

  return (
    <Box w={size} maw="100%">
      <Box className={classes.chessboard}>
        <Chessground
          fen={fen}
          orientation={orientation}
          turnColor={turn}
          coordinates
          // Never use viewOnly here: chessground only attaches its mouse/touch listeners when
          // the board is created, so a board that starts view-only can never be moved later.
          // Moves are blocked instead by leaving movable.color unset when onMove is missing.
          viewOnly={false}
          animation={{ enabled: true }}
          drawable={{ enabled: true, visible: true, autoShapes: allShapes }}
          movable={{
            free: false,
            color: onMove ? turn : undefined,
            dests,
            showDests: true,
            events: {
              after: (orig, dest) => {
                if (!onMove || !pos) return;
                const piece = pos.board.get(parseSquare(orig)!);
                let to: string = dest;
                // chessground lets you castle by dropping the king on the rook; use standard UCI.
                if (piece?.role === "king" && orig[0] === "e") {
                  if (dest[0] === "h") to = `g${dest[1]}`;
                  if (dest[0] === "a") to = `c${dest[1]}`;
                }
                const promo =
                  piece?.role === "pawn" && (dest[1] === "8" || dest[1] === "1") ? "q" : "";
                onMove(`${orig}${to}${promo}`);
              },
            },
          }}
          lastMove={
            lastMove ? [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key] : undefined
          }
          check={pos?.isCheck()}
        />
      </Box>
    </Box>
  );
}
