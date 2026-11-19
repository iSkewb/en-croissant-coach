import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconBulb, IconCheck, IconTarget, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { type DrillCard, gradeDrill, tagHint, training } from "@/utils/training";
import { MistakeBoard, uciToShape } from "./MistakeBoard";
import { MistakeExplanation, MistakeHeader } from "./MistakeDetail";

type Phase = "solving" | "correct" | "wrong";

/**
 * "Find the move you missed": each card is a position from your own games.
 * Hint ladder: 1) which piece, 2) what kind of idea (from the verified tags), 3) reveal.
 */
export default function MistakeDrill({ onChange }: { onChange?: () => void }) {
  const [queue, setQueue] = useState<DrillCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("solving");
  const [hints, setHints] = useState(0);
  const [tried, setTried] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const q = await training.drillQueue(20, 10).catch(() => []);
    setQueue(q);
    setIdx(0);
    setPhase("solving");
    setHints(0);
    setTried(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const card = queue[idx];

  if (loading) return <Text c="dimmed">Loading drills…</Text>;
  if (!card)
    return (
      <Alert icon={<IconCheck />} color="green" title="All caught up">
        {done > 0
          ? `You reviewed ${done} position${done === 1 ? "" : "s"}. New cards appear as you analyse more games.`
          : "No drills due. Analyse some games on the Overview tab to create them."}
        <Button mt="sm" size="xs" variant="light" onClick={load}>
          Check again
        </Button>
      </Alert>
    );

  const m = card.mistake;
  const fromSquare = m.bestUci.slice(0, 2);

  async function onMove(uci: string) {
    if (phase !== "solving") return;
    setTried(uci);
    const correct = uci === m.bestUci || uci.slice(0, 4) === m.bestUci.slice(0, 4);
    if (correct) {
      setPhase("correct");
      await gradeDrill(card, hints > 0 ? "correct_with_hint" : "correct");
    } else {
      setPhase("wrong");
      await gradeDrill(card, "wrong");
    }
    setDone((d) => d + 1);
    onChange?.();
  }

  function next() {
    setIdx((i) => i + 1);
    setPhase("solving");
    setHints(0);
    setTried(null);
  }

  const shapes =
    phase === "solving"
      ? []
      : [
          uciToShape(m.bestUci, "green"),
          ...(phase === "wrong" && tried ? [uciToShape(tried, "red")] : []),
        ].filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <MistakeBoard
        fen={m.fenBefore}
        orientation={m.playerColor}
        shapes={shapes}
        onMove={phase === "solving" ? onMove : undefined}
        highlightSquare={phase === "solving" && hints >= 1 ? fromSquare : null}
      />
      <Stack style={{ flex: 1 }} gap="sm">
        <Group justify="space-between">
          <Title order={4}>Find the better move ({m.playerColor} to play)</Title>
          <Text size="sm" c="dimmed">
            {idx + 1} / {queue.length}
          </Text>
        </Group>
        {card.focus && (
          <Badge leftSection={<IconTarget size="0.8rem" />} color="grape" variant="light">
            Current focus weakness
          </Badge>
        )}
        <Text size="sm">
          In your game you played <b>{m.playedSan}</b> here.{" "}
          {m.severity === "blunder" ? "It was a blunder." : ""}
        </Text>

        {phase === "solving" && (
          <Card withBorder p="sm">
            <Stack gap={6}>
              {hints >= 1 && <Text size="sm">Hint 1: the highlighted piece moves.</Text>}
              {hints >= 2 && <Text size="sm">Hint 2: {tagHint(m.tags)}</Text>}
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
                <Button size="xs" variant="subtle" color="gray" onClick={() => onMove("give-up")}>
                  Show answer
                </Button>
              </Group>
            </Stack>
          </Card>
        )}

        {phase !== "solving" && (
          <>
            <Alert
              color={phase === "correct" ? "green" : "red"}
              icon={phase === "correct" ? <IconCheck /> : <IconX />}
              title={phase === "correct" ? `Correct: ${m.bestSan}` : `The move was ${m.bestSan}`}
            >
              <Text size="sm">Line: {m.bestLine}</Text>
            </Alert>
            <MistakeHeader m={m} />
            <MistakeExplanation key={m.id} mistake={m} />
            <Group>
              <Button onClick={next}>Next</Button>
            </Group>
          </>
        )}
      </Stack>
    </Group>
  );
}
