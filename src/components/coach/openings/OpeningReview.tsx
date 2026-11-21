// Spaced-repetition review of your repertoire: replay lines from move 1, play your moves.
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type RepCard, scheduleCard, training } from "@/utils/training";
import { MistakeBoard, uciToShape } from "../MistakeBoard";
import { cardState, fenAfter, movesText, type SessionLine } from "./repertoire";

type Phase = "you" | "them" | "wrong" | "lineDone" | "done";

export default function OpeningReview({
  session,
  cards,
  onFinished,
  finishLabel = "Done",
  autoDelayMs = 450,
}: {
  session: SessionLine[];
  cards: RepCard[];
  onFinished: () => void;
  finishLabel?: string;
  autoDelayMs?: number;
}) {
  const [li, setLi] = useState(0);
  const [ply, setPly] = useState(0);
  const [phase, setPhase] = useState<Phase>("them");
  const [wrong, setWrong] = useState(0);
  const [lastWrong, setLastWrong] = useState<string | null>(null);
  const [stats, setStats] = useState({ practised: 0, firstTry: 0, learned: 0 });
  const cardRef = useRef(new Map(cards.map((c) => [`${c.side}|${c.posKey}`, c])));
  const now = useMemo(() => new Date(), []);

  const line = session[li];
  const plies = line?.parsed.plies ?? [];
  const side = line?.parsed.line.side ?? "white";
  const fen = line ? (ply < plies.length ? plies[ply].fen : fenAfter(plies.map((p) => p.uci))) : "";
  const current = plies[ply];
  const cardKey = current ? `${side}|${current.key}` : "";
  const isNew = current ? cardState(cardRef.current.get(cardKey), now) === "new" : false;

  // Decide what happens at each ply.
  useEffect(() => {
    if (!line || phase === "done") return;
    if (ply > line.endPly) {
      setPhase("lineDone");
      return;
    }
    if (current.by === "them") {
      setPhase("them");
      const t = setTimeout(() => setPly((p) => p + 1), autoDelayMs);
      return () => clearTimeout(t);
    }
    setPhase("you");
  }, [li, ply, line, current, phase === "done", autoDelayMs]);

  // Move on to the next line shortly after one finishes.
  useEffect(() => {
    if (phase !== "lineDone") return;
    const t = setTimeout(() => {
      if (li + 1 < session.length) {
        setLi(li + 1);
        setPly(0);
        setWrong(0);
        setPhase("them");
      } else setPhase("done");
    }, autoDelayMs * 2);
    return () => clearTimeout(t);
  }, [phase, li, session.length, autoDelayMs]);

  async function grade(rating: "good" | "again") {
    const prev = cardRef.current.get(cardKey);
    const next = scheduleCard(prev?.cardJson ?? null, rating);
    const card: RepCard = {
      side,
      posKey: current.key,
      cardJson: JSON.stringify(next),
      due: next.due.toISOString(),
    };
    cardRef.current.set(cardKey, card);
    await training.repSaveCard(card, rating === "again").catch(() => {});
  }

  function onMove(uci: string) {
    if (phase !== "you" && phase !== "wrong") return;
    if (uci === current.uci) {
      const graded = line.graded.has(current.key);
      if (graded || wrong > 0) {
        grade(wrong > 0 ? "again" : "good");
        setStats((s) => ({
          practised: s.practised + 1,
          firstTry: s.firstTry + (wrong === 0 && !isNew ? 1 : 0),
          learned: s.learned + (isNew ? 1 : 0),
        }));
      }
      setWrong(0);
      setLastWrong(null);
      setPhase("them");
      setPly((p) => p + 1);
    } else {
      setWrong((w) => w + 1);
      setLastWrong(uci);
      setPhase("wrong");
    }
  }

  if (session.length === 0)
    return (
      <Alert color="green" maw={560}>
        Nothing to review right now. Your openings are up to date.
        <Group mt="sm">
          <Button size="xs" onClick={onFinished}>
            {finishLabel}
          </Button>
        </Group>
      </Alert>
    );

  if (phase === "done")
    return (
      <Card withBorder maw={560}>
        <Stack gap="sm">
          <Title order={4}>Openings reviewed</Title>
          <Text>
            {stats.practised} position{stats.practised === 1 ? "" : "s"} practised
            {stats.learned ? `, ${stats.learned} new` : ""}
            {stats.practised - stats.learned > 0
              ? `, ${stats.firstTry} of ${stats.practised - stats.learned} reviews right first time`
              : ""}
            .
          </Text>
          <Text size="sm" c="dimmed">
            Moves you knew come back in a few days, then weeks. Ones you missed come back tomorrow.
          </Text>
          <Group>
            <Button onClick={onFinished}>{finishLabel}</Button>
          </Group>
        </Stack>
      </Card>
    );

  const shapes =
    phase === "you" && isNew
      ? [uciToShape(current.uci, "green")]
      : phase === "wrong" && wrong >= 1
        ? [uciToShape(current.uci, "green")]
        : [];
  const played = plies.slice(0, ply);
  const totalGraded = session.reduce((n, l) => n + l.graded.size, 0);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <MistakeBoard
        key={`${li}-${ply}-${wrong}`}
        fen={fen}
        orientation={side}
        lastMove={ply > 0 ? plies[ply - 1].uci : null}
        onMove={phase === "you" || phase === "wrong" ? onMove : undefined}
        shapes={shapes.filter((s) => s !== null)}
      />
      <Stack style={{ flex: 1 }} gap="sm" maw={460}>
        <Group justify="space-between">
          <Title order={4}>{line.parsed.line.name}</Title>
          <Text size="sm" c="dimmed">
            Line {li + 1} of {session.length}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          You play {side}
        </Text>
        <Progress value={(stats.practised / Math.max(1, totalGraded)) * 100} size="sm" />
        <Text ff="monospace" size="sm" mih={22}>
          {movesText(played) || " "}
        </Text>

        {phase === "you" && current && isNew && (
          <Alert color="blue" p="xs">
            <Group gap="xs">
              <Badge size="sm">New</Badge>
              <Text size="sm">
                Your move here is <b>{current.san}</b>. Play it to learn it.
              </Text>
            </Group>
          </Alert>
        )}
        {phase === "you" && !isNew && <Text fw={500}>What do you play here?</Text>}
        {phase === "them" && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Their move…
            </Text>
          </Group>
        )}
        {phase === "wrong" && current && (
          <Alert color="red" icon={<IconX />} p="xs">
            {lastWrong ? "That's not your repertoire move. " : ""}
            Your move here is <b>{current.san}</b>. Play it to continue.
          </Alert>
        )}
        {phase === "lineDone" && (
          <Alert color="green" icon={<IconCheck />} p="xs">
            Line complete.
          </Alert>
        )}
        <Group justify="flex-end">
          <Button size="xs" variant="subtle" color="gray" onClick={() => setPhase("done")}>
            End review
          </Button>
        </Group>
      </Stack>
    </Group>
  );
}
