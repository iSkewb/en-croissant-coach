// Build or edit one repertoire line by playing it on the board (both sides).
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconChevronLeft, IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { parseUci } from "chessops";
import { makeSan } from "chessops/san";
import { getDefaultStore } from "jotai";
import { useState } from "react";
import { positionFromFen } from "@/utils/chessops";
import { coachIngestSettingsAtom, formatEval, type RepLine, training } from "@/utils/training";
import { pickEngine } from "../autoAnalyze";
import { MistakeBoard } from "../MistakeBoard";
import { fenAfter, movesText, type Side, sanList } from "./repertoire";

type Suggestion = { uci: string; san: string; cp: number; mate: number | null };

export default function LineEditor({
  side,
  initialMoves,
  name: initialName,
  id = null,
  source = "mine",
  title = "New line",
  onSaved,
  onCancel,
}: {
  side: Side;
  initialMoves: string[];
  name?: string;
  id?: number | null;
  source?: RepLine["source"];
  title?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [moves, setMoves] = useState<string[]>(initialMoves);
  const [view, setView] = useState(initialMoves.length);
  const [name, setName] = useState(initialName ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = moves.slice(0, view);
  const fen = fenAfter(shown);
  const yourTurn = (fen.split(" ")[1] === "w") === (side === "white");
  const endsOnYourMove = moves.length > 0 && (moves.length % 2 === 1) === (side === "white");
  const sans = sanList(moves);

  function play(uci: string) {
    setMoves([...moves.slice(0, view), uci]);
    setView(view + 1);
    setSuggestions(null);
  }

  async function suggest() {
    setThinking(true);
    setError(null);
    try {
      const engine = pickEngine(getDefaultStore().get(coachIngestSettingsAtom).engineId);
      if (!engine) throw new Error("Install an engine on the Engines page to get suggestions.");
      const lines = await training.analyse(engine.path, fen, 18, 3);
      const [pos] = positionFromFen(fen);
      setSuggestions(
        lines
          .filter((l) => l.pvUci[0])
          .map((l) => ({
            uci: l.pvUci[0],
            san: pos ? makeSan(pos, parseUci(l.pvUci[0])!) : l.pvUci[0],
            cp: l.cp,
            mate: l.mate,
          })),
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setThinking(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await training.repSaveLine({
        id,
        side,
        name: name.trim() || movesText(sans.slice(0, 6)),
        moves: moves.join(" "),
        source,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs">
        <MistakeBoard
          key={view}
          fen={fen}
          orientation={side}
          lastMove={shown.at(-1) ?? null}
          onMove={play}
        />
        <Group justify="center" gap={4}>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.max(0, v - 1))}
            disabled={view === 0}
            aria-label="Back"
          >
            <IconChevronLeft size="1.1rem" />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.min(moves.length, v + 1))}
            disabled={view === moves.length}
            aria-label="Forward"
          >
            <IconChevronRight size="1.1rem" />
          </ActionIcon>
        </Group>
      </Stack>
      <Stack style={{ flex: 1 }} gap="sm" maw={460}>
        <Title order={4}>{title}</Title>
        <Text size="sm" c="dimmed">
          You play {side}. Play the moves for both sides on the board. Moves after the one you're
          looking at are replaced.
        </Text>
        <TextInput
          label="Name"
          placeholder={movesText(sans.slice(0, 6)) || "e.g. vs the Caro-Kann"}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Group gap={4}>
          {sans.map((s, k) => (
            <Button
              key={`${k}-${moves[k]}`}
              size="compact-sm"
              variant={k === view - 1 ? "filled" : "light"}
              color={(k % 2 === 0) === (side === "white") ? undefined : "gray"}
              onClick={() => setView(k + 1)}
            >
              {k % 2 === 0 ? `${k / 2 + 1}.` : ""}
              {s.san}
            </Button>
          ))}
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            leftSection={<IconSparkles size="0.9rem" />}
            onClick={suggest}
            loading={thinking}
          >
            {yourTurn ? "Suggest a move for me" : "Suggest their likely move"}
          </Button>
          {thinking && <Loader size="xs" />}
        </Group>
        {suggestions && (
          <Group gap="xs">
            {suggestions.map((sg) => (
              <Button key={sg.uci} size="compact-sm" variant="default" onClick={() => play(sg.uci)}>
                {sg.san}{" "}
                <Text span size="xs" c="dimmed" ml={4}>
                  {sg.mate !== null ? `#${sg.mate}` : formatEval(sg.cp)}
                </Text>
              </Button>
            ))}
          </Group>
        )}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        {moves.length > 0 && !endsOnYourMove && (
          <Alert color="yellow" p="xs">
            End the line with your own move, so you know what to play after their last move.
          </Alert>
        )}
        <Group>
          <Button onClick={save} disabled={!endsOnYourMove} loading={saving}>
            Save line
          </Button>
          <Button variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Group>
  );
}
