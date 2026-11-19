import { Anchor, Badge, Button, Group, List, Modal, Stack, Text, Title } from "@mantine/core";
import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { formatEval, type Mistake, tagLabel, training } from "@/utils/training";
import { MistakeBoard, uciToShape } from "./MistakeBoard";

export function MistakeExplanation({ mistake }: { mistake: Mistake }) {
  const [facts, setFacts] = useState<string[]>([]);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExplanation(null);
    setError(null);
    training
      .facts(mistake.id)
      .then(setFacts)
      .catch(() => setFacts([]));
  }, [mistake.id]);

  async function explain(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      setExplanation(await training.explain(mistake.id, refresh));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack gap="xs">
      {facts.length > 0 && (
        <>
          <Text size="sm" fw={600}>
            What the engine confirms
          </Text>
          <List size="sm" spacing={2}>
            {facts.map((f) => (
              <List.Item key={f}>{f}</List.Item>
            ))}
          </List>
        </>
      )}
      {explanation ? (
        <>
          <Text size="sm" fw={600}>
            Coach
          </Text>
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {explanation}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => explain(true)}
            loading={loading}
          >
            Regenerate
          </Button>
        </>
      ) : (
        <Button
          leftSection={<IconSparkles size="1rem" />}
          variant="light"
          onClick={() => explain(false)}
          loading={loading}
        >
          Explain why
        </Button>
      )}
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}

export function MistakeHeader({ m }: { m: Mistake }) {
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Badge
          color={m.severity === "blunder" ? "red" : m.severity === "mistake" ? "orange" : "yellow"}
        >
          {m.severity}
        </Badge>
        <Badge variant="outline">{m.phase}</Badge>
        {m.tags.map((t) => (
          <Badge key={t} variant="light" color="gray">
            {tagLabel(t)}
          </Badge>
        ))}
      </Group>
      <Text size="sm" c="dimmed">
        vs {m.opponent} · {m.opening ?? "Unknown opening"} · {m.date ?? ""}
        {m.timeSpentSecs != null && ` · ${Math.round(m.timeSpentSecs)}s spent`}
        {m.clockSecs != null && ` · ${Math.round(m.clockSecs)}s on clock`}
      </Text>
    </Stack>
  );
}

export function MistakeDetail({
  mistake,
  onClose,
}: {
  mistake: Mistake | null;
  onClose: () => void;
}) {
  if (!mistake) return null;
  const m = mistake;
  const shapes = [uciToShape(m.playedUci, "red"), uciToShape(m.bestUci, "green")].filter(
    (s): s is NonNullable<typeof s> => s !== null,
  );
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={<Title order={4}>Move {Math.floor(m.ply / 2) + 1}</Title>}
    >
      <Group align="flex-start" wrap="nowrap" gap="lg">
        <MistakeBoard fen={m.fenBefore} orientation={m.playerColor} shapes={shapes} size={380} />
        <Stack gap="sm" style={{ flex: 1 }}>
          <MistakeHeader m={m} />
          <Text size="sm">
            You played <b>{m.playedSan}</b> ({formatEval(m.evalBeforeCp)} →{" "}
            {formatEval(m.evalAfterCp)}, win chance {Math.round(m.winBefore)}% →{" "}
            {Math.round(m.winAfter)}%). Best was <b>{m.bestSan}</b>.
          </Text>
          <Text size="xs" c="dimmed">
            Best line: {m.bestLine}
            <br />
            Their best reply to your move: {m.refutationLine || "—"}
          </Text>
          <MistakeExplanation key={m.id} mistake={m} />
          {m.url && (
            <Anchor href={m.url} target="_blank" size="sm">
              Open game <IconExternalLink size="0.8rem" />
            </Anchor>
          )}
        </Stack>
      </Group>
    </Modal>
  );
}
