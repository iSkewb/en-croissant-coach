import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowBackUp,
  IconBulb,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconExternalLink,
  IconFlask,
  IconPlayerPlay,
  IconTarget,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeTabAtom, enginesAtom, tabsAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { createTab } from "@/utils/tabs";
import {
  coachIngestSettingsAtom,
  type DrillCard,
  type DrillLine,
  formatEval,
  gradeDrill,
  type MistakeContext,
  tagHint,
  training,
} from "@/utils/training";
import {
  drillOutcome,
  GRADE_COLOR,
  GRADE_LABEL,
  gradeMove,
  isAccepted,
  type MoveGrade,
  movesToPlay,
  playUci,
  sameMove,
} from "./drillLogic";
import { MistakeBoard, uciToShape } from "./MistakeBoard";
import { MistakeExplanation, MistakeHeader } from "./MistakeDetail";

const DEPTH = 14;

type Node = {
  fen: string;
  uci?: string;
  san?: string;
  by: "start" | "opp" | "you" | "game" | "explore";
  grade?: MoveGrade;
};

type Phase = "loading" | "intro" | "solving" | "thinking" | "wrong" | "done" | "explore";

function sideToMove(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function numberedMovetext(sans: string[], startFen: string | null): string {
  const blackFirst = !!startFen && sideToMove(startFen) === "black";
  const startNo = startFen ? Number(startFen.split(" ")[5] ?? 1) || 1 : 1;
  return sans
    .map((san, i) => {
      const k = i + (blackFirst ? 1 : 0);
      const no = startNo + Math.floor(k / 2);
      if (k % 2 === 0) return `${no}. ${san}`;
      return i === 0 ? `${no}... ${san}` : san;
    })
    .join(" ");
}

/**
 * Interactive "find the better move" drills from your own games.
 * - Good-but-not-best moves get credit (checked locally with Stockfish).
 * - Tactics are played out for a few moves against the engine.
 * - Back/forward through the moves, retry, explore freely, replay what happened in the game.
 */
export default function MistakeDrill({ onChange }: { onChange?: () => void }) {
  const ingest = useAtomValue(coachIngestSettingsAtom);
  const engines = useAtomValue(enginesAtom);
  const enginePath = useMemo(() => {
    const local = (engines ?? []).filter((e): e is LocalEngine => e.type === "local");
    return (local.find((e) => e.id === ingest.engineId) ?? local[0])?.path ?? null;
  }, [engines, ingest.engineId]);

  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const navigate = useNavigate();

  const [queue, setQueue] = useState<DrillCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [done, setDone] = useState(0);

  // per-card state
  const [nodes, setNodes] = useState<Node[]>([]);
  const [view, setView] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [startIdx, setStartIdx] = useState(0);
  const [stepStartIdx, setStepStartIdx] = useState(0);
  const [baseline, setBaseline] = useState(0);
  const [expectedBest, setExpectedBest] = useState<string | null>(null);
  const [grades, setGrades] = useState<MoveGrade[]>([]);
  const [hints, setHints] = useState(0);
  const [failed, setFailed] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [outcome, setOutcome] = useState<"correct" | "correct_with_hint" | "wrong" | null>(null);
  const [refutation, setRefutation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ctx, setCtx] = useState<MistakeContext | null>(null);
  const [exploreEval, setExploreEval] = useState<DrillLine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const cardToken = useRef(0);

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    const q = await training.drillQueue(20, 10).catch(() => []);
    setQueue(q);
    setIdx(0);
    setLoadingQueue(false);
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const card = queue[idx];
  const m = card?.mistake;

  // Set up a card: optional lead-in showing the opponent's last move.
  useEffect(() => {
    if (!m) return;
    const token = ++cardToken.current;
    setPhase("loading");
    setGrades([]);
    setHints(0);
    setFailed(0);
    setRevealed(false);
    setOutcome(null);
    setRefutation(null);
    setMessage(null);
    setExploreEval(null);
    setEngineError(null);
    setBaseline(m.evalBeforeCp);
    setExpectedBest(m.bestUci);

    const startPlain = () => {
      setNodes([{ fen: m.fenBefore, by: "start" }]);
      setView(0);
      setStartIdx(0);
      setStepStartIdx(0);
      setPhase("solving");
    };

    training
      .mistakeContext(m.id)
      .then((c) => {
        if (token !== cardToken.current) return;
        setCtx(c);
        if (c.prevFen && c.prevMoveUci) {
          setNodes([{ fen: c.prevFen, by: "start" }]);
          setView(0);
          setPhase("intro");
          setTimeout(() => {
            if (token !== cardToken.current) return;
            setNodes([
              { fen: c.prevFen!, by: "start" },
              { fen: m.fenBefore, uci: c.prevMoveUci!, san: c.prevMoveSan ?? undefined, by: "opp" },
            ]);
            setView(1);
            setStartIdx(1);
            setStepStartIdx(1);
            setPhase("solving");
          }, 900);
        } else {
          startPlain();
        }
      })
      .catch(() => {
        if (token !== cardToken.current) return;
        setCtx(null);
        startPlain();
      });
  }, [m?.id, idx]);

  const analyse = useCallback(
    async (fen: string, multipv = 1): Promise<DrillLine[] | null> => {
      if (!enginePath) return null;
      try {
        return await training.analyse(enginePath, fen, DEPTH, multipv);
      } catch (e) {
        setEngineError(String(e));
        return null;
      }
    },
    [enginePath],
  );

  async function finish(finalGrades: MoveGrade[], wasRevealed: boolean, failedCount = failed) {
    if (!card) return;
    const o = drillOutcome({
      grades: finalGrades,
      hints,
      failedAttempts: failedCount,
      revealed: wasRevealed,
    });
    setOutcome(o);
    setPhase("done");
    await gradeDrill(card, o);
    setDone((d) => d + 1);
    onChange?.();
  }

  async function onSolveMove(uci: string) {
    if (!m) return;
    const token = cardToken.current;
    const cur = nodes[nodes.length - 1];
    const r = playUci(cur.fen, uci);
    if (!r) return;
    const base = nodes;
    const userNode: Node = { fen: r.fen, uci, san: r.san, by: "you" };
    setNodes([...base, userNode]);
    setView(base.length);
    setPhase("thinking");
    setRefutation(null);
    setMessage(null);

    const firstStep = grades.length === 0;
    let moverCp: number | undefined;
    let grade: MoveGrade | undefined;
    if (sameMove(uci, expectedBest)) {
      grade = "best";
      moverCp = baseline;
    } else if (firstStep && m.secondUci && sameMove(uci, m.secondUci) && m.secondCp != null) {
      moverCp = m.secondCp;
    }

    let after: DrillLine | null = null;
    if (r.over) {
      moverCp = r.mate ? 1000 : 0;
      if (r.mate) grade = "best";
    } else {
      const lines = await analyse(r.fen);
      if (token !== cardToken.current) return;
      after = lines?.[0] ?? null;
      if (after && moverCp === undefined) moverCp = -after.cp;
    }

    if (moverCp === undefined) {
      // No engine available: only the engine's top moves count.
      grade = "wrong";
      moverCp = -1000;
    }
    let drop = 0;
    if (!grade) {
      const g = gradeMove(baseline, moverCp);
      grade = g.grade;
      drop = g.drop;
    }
    const gradedNode = { ...userNode, grade };

    if (!isAccepted(grade)) {
      const failedNow = failed + 1;
      setFailed(failedNow);
      setNodes([...base, gradedNode]);
      const reply = after?.pvSan[0];
      setRefutation(after?.pvUci[0] ?? null);
      setMessage(
        `${r.san} is ${grade === "wrong" ? "a mistake" : "inaccurate"}` +
          (drop ? ` (it gives up about ${Math.round(drop)}% win chance)` : "") +
          (reply ? `. They would answer ${reply}.` : "."),
      );
      setPhase("wrong");
      return;
    }

    const newGrades = [...grades, grade];
    setGrades(newGrades);
    const withUser = [...base, gradedNode];
    setNodes(withUser);
    if (grade === "good") {
      setMessage(
        `${r.san} is good. ${m && firstStep ? `${m.bestSan} was a little stronger.` : ""}`,
      );
    }

    const target = movesToPlay(m.tags);
    const replyUci = after?.pvUci[0];
    if (r.over || newGrades.length >= target || !replyUci) {
      await finish(newGrades, revealed);
      return;
    }

    // Opponent replies with the engine's best move; you continue.
    const rr = playUci(r.fen, replyUci);
    if (!rr) {
      await finish(newGrades, revealed);
      return;
    }
    setTimeout(() => {
      if (token !== cardToken.current) return;
      const oppNode: Node = { fen: rr.fen, uci: replyUci, san: rr.san, by: "opp" };
      setNodes([...withUser, oppNode]);
      setView(withUser.length);
      setStepStartIdx(withUser.length);
      setBaseline(after ? -after.cp : moverCp!);
      setExpectedBest(after?.pvUci[1] ?? null);
      setHints(0);
      if (rr.over) {
        finish(newGrades, revealed);
      } else {
        setPhase("solving");
      }
    }, 450);
  }

  function tryAgain() {
    setNodes(nodes.slice(0, stepStartIdx + 1));
    setView(stepStartIdx);
    setRefutation(null);
    setMessage(null);
    setPhase("solving");
  }

  async function showAnswer() {
    const stepNode = nodes[stepStartIdx];
    const base = nodes.slice(0, stepStartIdx + 1);
    let answer = expectedBest;
    if (!answer) {
      const lines = await analyse(stepNode.fen);
      answer = lines?.[0]?.pvUci[0] ?? null;
    }
    const r = answer ? playUci(stepNode.fen, answer) : null;
    if (r && answer) {
      setNodes([...base, { fen: r.fen, uci: answer, san: r.san, by: "you", grade: "best" }]);
      setView(base.length);
      setMessage(`The move was ${r.san}.`);
    }
    setRevealed(true);
    setRefutation(null);
    await finish(grades, true);
  }

  async function onExploreMove(uci: string) {
    const cur = nodes[view];
    const r = playUci(cur.fen, uci);
    if (!r) return;
    const next = [
      ...nodes.slice(0, view + 1),
      { fen: r.fen, uci, san: r.san, by: "explore" as const },
    ];
    setNodes(next);
    setView(next.length - 1);
    setExploreEval(null);
    if (!r.over) {
      const lines = await analyse(r.fen);
      setExploreEval(lines?.[0] ?? null);
    }
  }

  function showGame() {
    if (!ctx || ctx.gameContinuationUci.length === 0) return;
    const out = nodes.slice(0, startIdx + 1);
    let fen = out[out.length - 1].fen;
    for (const u of ctx.gameContinuationUci) {
      const r = playUci(fen, u);
      if (!r) break;
      out.push({ fen: r.fen, uci: u, san: r.san, by: "game" });
      fen = r.fen;
    }
    setNodes(out);
    setView(startIdx + 1);
    setExploreEval(null);
    setPhase("explore");
  }

  async function openInAnalysis() {
    if (!m) return;
    const hasGame = !!ctx && ctx.allMovesSan.length > 0;
    const startFen = hasGame ? (ctx!.startFen ?? INITIAL_FEN) : m.fenBefore;
    await createTab({
      tab: { name: `Coach: move ${Math.floor(m.ply / 2) + 1} vs ${m.opponent}`, type: "analysis" },
      setTabs,
      setActiveTab,
      pgn: hasGame ? numberedMovetext(ctx!.allMovesSan, ctx!.startFen) : "",
      headers: {
        id: 0,
        fen: startFen,
        event: "Coach drill",
        site: m.url ?? "",
        white: m.playerColor === "white" ? "You" : m.opponent,
        black: m.playerColor === "black" ? "You" : m.opponent,
        result: "*",
        orientation: m.playerColor,
      },
      position: hasGame ? Array(m.ply).fill(0) : undefined,
    });
    navigate({ to: "/" });
  }

  function next() {
    setIdx((i) => i + 1);
  }

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") setView((v) => Math.max(0, v - 1));
      if (e.key === "ArrowRight") setView((v) => Math.min(nodes.length - 1, v + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes.length]);

  if (loadingQueue) return <Text c="dimmed">Loading drills…</Text>;
  if (!card || !m)
    return (
      <Alert icon={<IconCheck />} color="green" title="All caught up">
        {done > 0
          ? `You reviewed ${done} position${done === 1 ? "" : "s"}. New cards appear as you analyse more games.`
          : "No drills due. Analyse some games on the Overview tab to create them."}
        <Button mt="sm" size="xs" variant="light" onClick={loadQueue}>
          Check again
        </Button>
      </Alert>
    );

  const atEnd = view === nodes.length - 1;
  const current = nodes[view];
  const interactive = (phase === "solving" && atEnd) || phase === "explore";
  const userMovesPlayed = grades.length;
  const target = movesToPlay(m.tags);

  const shapes = [
    ...(phase === "wrong" && atEnd && refutation ? [uciToShape(refutation, "red")] : []),
    ...((phase === "done" || phase === "explore") && view === startIdx
      ? [uciToShape(m.bestUci, "green")]
      : []),
    ...(phase === "explore" && atEnd && exploreEval?.pvUci[0]
      ? [uciToShape(exploreEval.pvUci[0], "blue")]
      : []),
  ].filter((s): s is NonNullable<typeof s> => s !== null);

  const exploreEvalText = (() => {
    if (!exploreEval || !current) return null;
    const mine = sideToMove(current.fen) === m.playerColor ? exploreEval.cp : -exploreEval.cp;
    return `${formatEval(mine)} for you · best: ${exploreEval.pvSan[0] ?? "—"}`;
  })();

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs">
        <MistakeBoard
          fen={current?.fen ?? m.fenBefore}
          orientation={m.playerColor}
          shapes={shapes}
          lastMove={current?.uci ?? null}
          onMove={interactive ? (phase === "explore" ? onExploreMove : onSolveMove) : undefined}
          highlightSquare={
            phase === "solving" && hints >= 1 && expectedBest ? expectedBest.slice(0, 2) : null
          }
        />
        <Group justify="center" gap={4}>
          <ActionIcon variant="subtle" onClick={() => setView(0)} disabled={view === 0}>
            <IconChevronsLeft size="1.1rem" />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.max(0, v - 1))}
            disabled={view === 0}
          >
            <IconChevronLeft size="1.1rem" />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.min(nodes.length - 1, v + 1))}
            disabled={atEnd}
          >
            <IconChevronRight size="1.1rem" />
          </ActionIcon>
          <ActionIcon variant="subtle" onClick={() => setView(nodes.length - 1)} disabled={atEnd}>
            <IconChevronsRight size="1.1rem" />
          </ActionIcon>
        </Group>
      </Stack>

      <Stack style={{ flex: 1 }} gap="sm">
        <Group justify="space-between">
          <Title order={4}>
            {phase === "intro"
              ? "Your opponent just played…"
              : phase === "explore"
                ? "Explore"
                : phase === "done"
                  ? "Drill complete"
                  : userMovesPlayed === 0
                    ? `Find the better move (${m.playerColor} to play)`
                    : `Keep going: ${target - userMovesPlayed} more move${target - userMovesPlayed === 1 ? "" : "s"}`}
          </Title>
          <Text size="sm" c="dimmed">
            {idx + 1} / {queue.length}
          </Text>
        </Group>
        {card.focus && (
          <Badge leftSection={<IconTarget size="0.8rem" />} color="grape" variant="light">
            Current focus weakness
          </Badge>
        )}
        {!enginePath && (
          <Alert color="yellow" p="xs">
            Pick an engine in Coach → Settings to get credit for good alternative moves and to play
            lines out.
          </Alert>
        )}
        {engineError && (
          <Text size="xs" c="red">
            Engine: {engineError}
          </Text>
        )}

        {/* Move list */}
        <Group gap={4}>
          {nodes.slice(1).map((n, i) => (
            <Button
              key={`${i}-${n.uci}`}
              size="compact-sm"
              variant={view === i + 1 ? "filled" : "light"}
              color={
                n.grade
                  ? GRADE_COLOR[n.grade]
                  : n.by === "game"
                    ? "gray"
                    : n.by === "explore"
                      ? "blue"
                      : "dark"
              }
              onClick={() => setView(i + 1)}
            >
              {n.by === "game" ? "game: " : ""}
              {n.san}
            </Button>
          ))}
          {phase === "thinking" && <Loader size="xs" />}
        </Group>

        {userMovesPlayed === 0 && phase !== "done" && phase !== "explore" && (
          <Text size="sm">
            In your game you played <b>{m.playedSan}</b> here
            {m.severity === "blunder" ? ", a blunder" : ""}.
          </Text>
        )}

        {message && (
          <Text size="sm" c={phase === "wrong" ? "red" : undefined}>
            {message}
          </Text>
        )}

        {phase === "solving" && (
          <Card withBorder p="sm">
            <Stack gap={6}>
              {hints >= 1 && expectedBest && (
                <Text size="sm">Hint: the highlighted piece moves.</Text>
              )}
              {hints >= 2 && <Text size="sm">Hint: {tagHint(m.tags)}</Text>}
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconBulb size="0.9rem" />}
                  onClick={() => setHints((h) => Math.min(h + 1, 2))}
                  disabled={hints >= 2}
                >
                  Hint
                </Button>
                <Button size="xs" variant="subtle" color="gray" onClick={showAnswer}>
                  Show answer
                </Button>
              </Group>
            </Stack>
          </Card>
        )}

        {phase === "wrong" && (
          <Group gap="xs">
            <Button size="xs" leftSection={<IconArrowBackUp size="0.9rem" />} onClick={tryAgain}>
              Try again
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={showAnswer}>
              Show answer
            </Button>
          </Group>
        )}

        {(phase === "done" || phase === "explore") && outcome && (
          <>
            <Alert
              color={
                outcome === "correct" ? "green" : outcome === "correct_with_hint" ? "lime" : "red"
              }
              icon={outcome === "wrong" ? <IconX /> : <IconCheck />}
              title={
                outcome === "correct"
                  ? "Solved"
                  : outcome === "correct_with_hint"
                    ? "Solved, with help"
                    : "Missed"
              }
            >
              <Group gap={4}>
                {grades.map((g, i) => (
                  <Badge key={i} color={GRADE_COLOR[g]} variant="light">
                    {GRADE_LABEL[g]}
                  </Badge>
                ))}
              </Group>
              <Text size="sm" mt={4}>
                Engine line from the game position: {m.bestLine}
              </Text>
            </Alert>
            {phase === "explore" && (
              <Text size="sm" c="dimmed">
                {exploreEvalText ??
                  "Move pieces freely; the engine evaluates each position. Use the arrows to go back."}
              </Text>
            )}
            <Group gap="xs">
              <Button onClick={next} leftSection={<IconPlayerPlay size="0.9rem" />}>
                Next
              </Button>
              {phase !== "explore" && (
                <Button
                  variant="light"
                  leftSection={<IconFlask size="0.9rem" />}
                  onClick={() => setPhase("explore")}
                >
                  Explore
                </Button>
              )}
              {ctx && ctx.gameContinuationUci.length > 0 && (
                <Button variant="light" color="gray" onClick={showGame}>
                  Show the game
                </Button>
              )}
              <Tooltip label="Open the full game at this move in a new analysis tab">
                <Button
                  variant="subtle"
                  leftSection={<IconExternalLink size="0.9rem" />}
                  onClick={openInAnalysis}
                >
                  Analysis board
                </Button>
              </Tooltip>
            </Group>
            <MistakeHeader m={m} />
            <MistakeExplanation key={m.id} mistake={m} />
          </>
        )}
      </Stack>
    </Group>
  );
}
