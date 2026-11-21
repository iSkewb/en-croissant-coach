// Lesson steps that don't map onto an existing screen: online catch-up, look back, check-in.
import { Alert, Badge, Button, Card, Group, List, Loader, Stack, Text } from "@mantine/core";
import { getDefaultStore } from "jotai";
import { useEffect, useState } from "react";
import { sessionsAtom } from "@/state/atoms";
import { downloadChessCom } from "@/utils/chess.com/api";
import { downloadLichess } from "@/utils/lichess/api";
import { type Insight, type Mistake, training } from "@/utils/training";
import { analyzeAccount, connectedAccounts } from "../autoAnalyze";
import MistakeDrill from "../MistakeDrill";
import { COACH_SERIF } from "./settings";

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function OnlineStep({ date, onDone }: { date: string; onDone: () => void }) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setStatus("running");
    setMessage("Fetching your recent games…");
    let games = 0;
    let mistakes = 0;
    try {
      const sessions = getDefaultStore().get(sessionsAtom);
      for (const acc of connectedAccounts()) {
        const since = Date.now() - WEEK_MS;
        if (acc.site === "chesscom") {
          await downloadChessCom(acc.username, since);
        } else {
          const token = sessions.find((s) => s.lichess?.username === acc.username)?.lichess
            ?.accessToken;
          await downloadLichess(acc.username, since, 50, () => {}, token);
        }
        setMessage(`Analysing ${acc.username}'s games…`);
        const s = await analyzeAccount(acc);
        games += s?.gamesAnalyzed ?? 0;
        mistakes += s?.mistakesFound ?? 0;
      }
      await training.setMark(date, "online", true);
      setStatus("done");
      setMessage(
        games === 0
          ? "No new online games since last time."
          : `Analysed ${games} new game${games === 1 ? "" : "s"}: ${mistakes} mistake${mistakes === 1 ? "" : "s"} added to your reviews.`,
      );
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  }

  return (
    <Card withBorder maw={560}>
      <Stack gap="sm">
        {message && (
          <Group gap="xs">
            {status === "running" && <Loader size="xs" />}
            <Text size="sm" c={status === "error" ? "red" : undefined}>
              {message}
            </Text>
          </Group>
        )}
        <Group>
          {status === "idle" && <Button onClick={run}>Fetch and analyse</Button>}
          {status === "error" && <Button onClick={run}>Try again</Button>}
          {(status === "done" || status === "error") && (
            <Button variant={status === "done" ? "filled" : "subtle"} onClick={onDone}>
              Back to lesson
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

export function LookBackStep({
  date,
  tz,
  onDone,
}: {
  date: string;
  tz: number;
  onDone: () => void;
}) {
  const [mistake, setMistake] = useState<Mistake | null | undefined>(undefined);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    training
      .lookbackMistake(tz)
      .then((m) => setMistake(m))
      .catch(() => setMistake(null));
  }, [tz, tries]);

  async function finish() {
    await training.setMark(date, "lookback", true);
    onDone();
  }

  if (mistake === undefined) return <Loader />;
  if (mistake === null)
    return (
      <Card withBorder maw={560}>
        <Stack gap="sm">
          <Text size="sm">
            No mistakes found in today's games yet. If you just finished a game, the analysis may
            still be running.
          </Text>
          <Group>
            <Button variant="light" onClick={() => setTries((t) => t + 1)}>
              Check again
            </Button>
            <Button variant="subtle" onClick={finish}>
              Clean game: mark as done
            </Button>
          </Group>
        </Stack>
      </Card>
    );

  return (
    <MistakeDrill
      key={mistake.id}
      fixedCards={[{ mistake, cardJson: null, focus: true }]}
      onFinished={finish}
      finishLabel="Done: back to lesson"
      autoExplain
    />
  );
}

export function CheckinStep({ date, onDone }: { date: string; onDone: () => void }) {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    training
      .runInsights()
      .then((i) => setInsight(i))
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  }, []);

  async function finish() {
    await training.setMark(date, "checkin", true);
    onDone();
  }

  if (running)
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm">The coach is reviewing your week…</Text>
      </Group>
    );
  if (error || !insight)
    return (
      <Alert color="yellow" title="Couldn't run the check-in" maw={560}>
        <Text size="sm">{error ?? "No result."}</Text>
        <Button mt="sm" size="xs" variant="light" onClick={finish}>
          Skip for this week
        </Button>
      </Alert>
    );

  const top = [...insight.weaknesses].sort((a, b) => a.priority - b.priority);
  return (
    <Card withBorder maw={640}>
      <Stack gap="sm">
        <Text style={{ fontFamily: COACH_SERIF }} size="lg">
          {insight.summary}
        </Text>
        {insight.progressNote && (
          <Text size="sm" c="dimmed">
            {insight.progressNote}
          </Text>
        )}
        {top[0] && (
          <Stack gap={2}>
            <Group gap="xs">
              <Badge variant="light">Next week's focus</Badge>
              <Text fw={500}>{top[0].title}</Text>
            </Group>
            <Text size="sm">Rule: {top[0].ruleOfThumb}</Text>
          </Stack>
        )}
        {insight.plan.length > 0 && (
          <List size="sm" spacing={2}>
            {insight.plan.slice(0, 4).map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        )}
        <Group>
          <Button onClick={finish}>Finish the week</Button>
        </Group>
      </Stack>
    </Card>
  );
}
