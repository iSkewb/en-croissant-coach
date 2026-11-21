// Practice → Endgames: the course, in order, with stars per drill.
import { Badge, Button, Group, Loader, Paper, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconLock, IconStar, IconStarFilled } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { type EndgameStat, training } from "@/utils/training";
import { tzOffsetMinutes } from "../lesson/settings";
import { courseProgress, type Drill, goalText, nextDrill } from "./curriculum";
import EndgameSession from "./EndgameSession";

export function Stars({ n }: { n: number }) {
  return (
    <Group gap={2} aria-label={`${n} of 3 stars`}>
      {[0, 1, 2].map((k) =>
        k < n ? (
          <IconStarFilled key={k} size={14} color="var(--mantine-color-yellow-5)" />
        ) : (
          <IconStar key={k} size={14} color="var(--mantine-color-dimmed)" />
        ),
      )}
    </Group>
  );
}

export default function EndgameCourse() {
  const [stats, setStats] = useState<EndgameStat[] | null>(null);
  const [active, setActive] = useState<Drill | null>(null);

  const reload = useCallback(() => {
    training
      .endgameStats(tzOffsetMinutes())
      .then(setStats)
      .catch(() => setStats([]));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  if (active)
    return (
      <EndgameSession
        drill={active}
        onExit={() => {
          setActive(null);
          reload();
        }}
        onFinished={setStats}
        exitLabel="Back to endgames"
      />
    );
  if (!stats) return <Loader />;

  const course = courseProgress(stats);
  const suggested = nextDrill(stats).id;

  return (
    <Stack gap="xs" maw={720}>
      <Text size="sm" c="dimmed">
        Learn these in order. Each one unlocks after you solve the one before it; three stars (clean
        solves on three different days) and it's yours.
      </Text>
      {course.map(({ drill, unlocked, stars, attempts }, k) => (
        <Paper
          key={drill.id}
          withBorder
          p="sm"
          radius="md"
          data-testid={`endgame-${drill.id}`}
          style={{
            opacity: unlocked ? 1 : 0.55,
            borderColor: drill.id === suggested ? "var(--mantine-primary-color-filled)" : undefined,
          }}
        >
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon radius="xl" size={28} variant={stars === 3 ? "filled" : "default"}>
                {unlocked ? (
                  <Text size="xs" fw={700}>
                    {k + 1}
                  </Text>
                ) : (
                  <IconLock size={14} />
                )}
              </ThemeIcon>
              <div>
                <Group gap="xs">
                  <Text fw={600}>{drill.title}</Text>
                  {drill.id === suggested && (
                    <Badge size="xs" variant="light">
                      Next
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {drill.summary} · {goalText(drill.goal).toLowerCase()}
                </Text>
              </div>
            </Group>
            <Group gap="sm" wrap="nowrap">
              {attempts > 0 && <Stars n={stars} />}
              <Button
                size="xs"
                variant={drill.id === suggested ? "filled" : "light"}
                disabled={!unlocked}
                onClick={() => setActive(drill)}
              >
                {attempts > 0 ? "Practise" : "Start"}
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
