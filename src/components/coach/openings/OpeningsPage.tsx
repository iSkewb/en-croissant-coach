// Practice → Openings: your repertoire, how your games compare with it, and reviews.
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type RepCard, type RepGame, type RepLine, training } from "@/utils/training";
import OpeningReview from "./OpeningReview";
import LineEditor from "./LineEditor";
import {
  buildBook,
  counts,
  coverage,
  movesText,
  type ParsedLine,
  parseLine,
  planSession,
  type Side,
  sanToUci,
  yourPositions,
} from "./repertoire";
import { STARTERS } from "./starters";

const SEEN_KEY = "coach-rep-deviations-seen";

export async function importStarters(ids: string[]) {
  for (const st of STARTERS.filter((s) => ids.includes(s.id)))
    for (const l of st.lines) {
      const moves = sanToUci(l.san);
      if (moves)
        await training.repSaveLine({
          id: null,
          side: st.side,
          name: `${st.title}: ${l.name}`,
          moves,
          source: "starter",
        });
    }
}

export function StarterPicker({
  onDone,
  existing = [],
}: {
  onDone: () => void;
  existing?: RepLine[];
}) {
  const have = new Set(
    existing.filter((l) => l.source === "starter").map((l) => l.name.split(":")[0]),
  );
  const [picked, setPicked] = useState<string[]>(
    STARTERS.filter((s) => !have.has(s.title)).map((s) => s.id),
  );
  const [busy, setBusy] = useState(false);
  return (
    <Card withBorder maw={640}>
      <Stack gap="sm">
        <Title order={5}>Start with a repertoire</Title>
        <Text size="sm" c="dimmed">
          Small, sound repertoires built around a few ideas. You can edit any line, or add your own.
        </Text>
        {STARTERS.map((st) => (
          <Checkbox
            key={st.id}
            disabled={have.has(st.title)}
            checked={picked.includes(st.id)}
            onChange={(e) =>
              setPicked(
                e.currentTarget.checked ? [...picked, st.id] : picked.filter((p) => p !== st.id),
              )
            }
            label={`${st.title} (as ${st.side}, ${st.lines.length} lines)${have.has(st.title) ? ": added" : ""}`}
            description={st.summary}
          />
        ))}
        <Group>
          <Button
            loading={busy}
            disabled={picked.length === 0}
            onClick={async () => {
              setBusy(true);
              await importStarters(picked).catch(() => {});
              setBusy(false);
              onDone();
            }}
          >
            Add {picked.length === 1 ? "it" : "them"}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

type Editing = {
  side: Side;
  moves: string[];
  name?: string;
  id?: number | null;
  source?: RepLine["source"];
  title?: string;
};

export default function OpeningsPage() {
  const [lines, setLines] = useState<RepLine[] | null>(null);
  const [cards, setCards] = useState<RepCard[]>([]);
  const [games, setGames] = useState<RepGame[]>([]);
  const [side, setSide] = useState<Side>("white");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [showStarters, setShowStarters] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const [l, c, g] = await Promise.all([
      training.repLines().catch(() => [] as RepLine[]),
      training.repCards().catch(() => [] as RepCard[]),
      training.repGames(60).catch(() => [] as RepGame[]),
    ]);
    setLines(l);
    setCards(c);
    setGames(g);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const parsed: ParsedLine[] = useMemo(() => (lines ?? []).map(parseLine), [lines]);
  const cov = useMemo(() => coverage(parsed, games), [parsed, games]);
  const now = useMemo(() => new Date(), [cards]);
  const c = useMemo(() => counts(parsed, cards, now), [parsed, cards, now]);

  // Positions you got wrong in real games come back for review now (once per game).
  useEffect(() => {
    if (!lines || cov.deviations.length === 0) return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    } catch {}
    const fresh = cov.deviations.filter((d) => !seen.includes(d.game.gameId));
    if (fresh.length === 0) return;
    (async () => {
      for (const d of fresh) {
        const card = cards.find((x) => x.side === d.side && x.posKey === d.key);
        if (card && new Date(card.due) > new Date())
          await training
            .repSaveCard({ ...card, due: new Date().toISOString() }, null)
            .catch(() => {});
      }
      try {
        localStorage.setItem(
          SEEN_KEY,
          JSON.stringify([...seen, ...fresh.map((d) => d.game.gameId)].slice(-500)),
        );
      } catch {}
      reload();
    })();
  }, [lines, cov.deviations, cards, reload]);

  if (!lines) return <Loader />;

  if (editing)
    return (
      <LineEditor
        side={editing.side}
        initialMoves={editing.moves}
        name={editing.name}
        id={editing.id ?? null}
        source={editing.source}
        title={editing.title}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );

  if (reviewing)
    return (
      <OpeningReview
        session={planSession(parsed, cards, new Date(), { maxPositions: 12, maxNew: 6 })}
        cards={cards}
        finishLabel="Back to openings"
        onFinished={() => {
          setReviewing(false);
          reload();
        }}
      />
    );

  if (lines.length === 0) return <StarterPicker onDone={reload} />;

  const sideLines = parsed.filter((p) => p.line.side === side);
  const conflicts = yourPositions(buildBook(parsed, side)).filter((e) => e.conflicts.length > 0);

  return (
    <Stack maw={860}>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder>
          <Stack gap={6}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Review
            </Text>
            <Text fz={26} fw={700}>
              {c.due} due{c.fresh > 0 ? ` · ${c.fresh} new` : ""}
            </Text>
            <Text size="sm" c="dimmed">
              {c.total} positions where you know your move
            </Text>
            <Group>
              <Button onClick={() => setReviewing(true)} disabled={c.due + c.fresh === 0}>
                Review now
              </Button>
            </Group>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={6}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Your games
            </Text>
            {cov.games === 0 ? (
              <Text size="sm" c="dimmed">
                Analyse some games and the coach will show where you leave your repertoire.
              </Text>
            ) : (
              <>
                <Text fz={26} fw={700}>
                  {cov.avgYourMoves.toFixed(1)} moves
                </Text>
                <Text size="sm" c="dimmed">
                  in your repertoire on average, over your last {cov.games} games
                </Text>
              </>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      {cov.gaps.length > 0 && (
        <Card withBorder>
          <Title order={6} mb={4}>
            Not in your repertoire yet
          </Title>
          <Text size="sm" c="dimmed" mb="xs">
            Positions from your games where you had no prepared move, most common first.
          </Text>
          <Stack gap={6}>
            {cov.gaps.slice(0, 6).map((g) => (
              <Group key={`${g.side}|${g.key}`} justify="space-between" wrap="nowrap">
                <Text size="sm">
                  {g.label}{" "}
                  <Text span size="xs" c="dimmed">
                    (as {g.side}, {g.games} game{g.games === 1 ? "" : "s"})
                  </Text>
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() =>
                    setEditing({
                      side: g.side,
                      moves: g.prefix,
                      title: `Add a reply: ${g.label.toLowerCase()}`,
                      source: "game",
                    })
                  }
                >
                  Add a reply
                </Button>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {cov.deviations.length > 0 && (
        <Card withBorder>
          <Title order={6} mb={4}>
            Where you left your repertoire
          </Title>
          <Text size="sm" c="dimmed" mb="xs">
            These positions are put back in your reviews.
          </Text>
          <Stack gap={4}>
            {cov.deviations.slice(0, 6).map((d) => (
              <Text key={d.game.gameId} size="sm">
                vs {d.game.opponent ?? "opponent"}
                {d.game.date ? ` (${d.game.date})` : ""}: move {d.moveNo}, you played{" "}
                <Text span c="red">
                  {d.played}
                </Text>
                , your repertoire says{" "}
                <Text span c="green">
                  {d.expected}
                </Text>
              </Text>
            ))}
          </Stack>
        </Card>
      )}

      <Group justify="space-between">
        <SegmentedControl
          value={side}
          onChange={(v) => setSide(v as Side)}
          data={[
            {
              value: "white",
              label: `As White (${parsed.filter((p) => p.line.side === "white").length})`,
            },
            {
              value: "black",
              label: `As Black (${parsed.filter((p) => p.line.side === "black").length})`,
            },
          ]}
        />
        <Group gap="xs">
          <Button size="xs" variant="subtle" onClick={() => setShowStarters((s) => !s)}>
            Starter repertoires
          </Button>
          <Button
            size="xs"
            leftSection={<IconPlus size="0.9rem" />}
            onClick={() => setEditing({ side, moves: [] })}
          >
            New line
          </Button>
        </Group>
      </Group>
      {showStarters && (
        <StarterPicker
          existing={lines}
          onDone={() => {
            setShowStarters(false);
            reload();
          }}
        />
      )}
      {conflicts.length > 0 && (
        <Alert color="yellow" p="xs">
          {conflicts.length} position{conflicts.length === 1 ? " has" : "s have"} two different
          moves of yours in different lines. Reviews use the first; edit a line to pick one.
        </Alert>
      )}
      {sideLines.length === 0 && (
        <Text size="sm" c="dimmed">
          No lines as {side} yet. Add one, or use "Add a reply" above for positions from your games.
        </Text>
      )}
      <Stack gap={6}>
        {sideLines.map((p) => (
          <Paper key={p.line.id} withBorder p="sm" radius="md">
            <Group justify="space-between" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm">
                  {p.line.name}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace" truncate>
                  {p.error ?? movesText(p.plies)}
                </Text>
              </div>
              <Group gap={4} wrap="nowrap">
                <Tooltip label="Edit">
                  <ActionIcon
                    variant="subtle"
                    aria-label={`Edit ${p.line.name}`}
                    onClick={() =>
                      setEditing({
                        side: p.line.side,
                        moves: p.plies.map((x) => x.uci),
                        name: p.line.name,
                        id: p.line.id,
                        source: p.line.source,
                        title: "Edit line",
                      })
                    }
                  >
                    <IconPencil size={16} />
                  </ActionIcon>
                </Tooltip>
                {confirmDelete === p.line.id ? (
                  <Group gap={4} wrap="nowrap">
                    <Button
                      size="compact-xs"
                      color="red"
                      onClick={async () => {
                        if (p.line.id !== null)
                          await training.repDeleteLine(p.line.id).catch(() => {});
                        setConfirmDelete(null);
                        reload();
                      }}
                    >
                      Delete
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Keep
                    </Button>
                  </Group>
                ) : (
                  <Tooltip label="Delete">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Delete ${p.line.name}`}
                      onClick={() => setConfirmDelete(p.line.id)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            </Group>
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
