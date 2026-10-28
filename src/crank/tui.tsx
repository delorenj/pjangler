// Ink screens for `pj crank` (PJAN-182): the interval picker `pj crank enable` shows, and
// the full-screen dashboard behind `pj crank tui`. Built as its own esbuild entry
// (dist/crank/tui.js) and loaded lazily, so ink/react stay out of every other command.

import { Box, Text, useInput, useWindowSize } from "ink";
import { useCallback, useState } from "react";
import { KeyHints, RadioGroup, runInk, useInterval, useNow, themeColor, marks, type RadioOption, type RunInkOptions } from "../tui";
import type { CrankController, CrankView } from "./controller";
import {
  ZCRANK_INTERVALS,
  formatAge,
  formatDuration,
  nextRunMs,
  renderLogRow,
  type CrankInterval,
} from "./index";

/** The four choices, with the global default badged. */
export function intervalOptions(global: CrankInterval): RadioOption<CrankInterval>[] {
  return ZCRANK_INTERVALS.map((value) => ({ value, label: value, badge: value === global ? "global" : undefined }));
}

function inheritanceNote(inherited: boolean, global: CrankInterval): string {
  return inherited ? `inherits global (${global})` : `project override (global is ${global})`;
}

// ---------------------------------------------------------------------------
// Picker (pj crank enable)
// ---------------------------------------------------------------------------

export interface PickerProps {
  slug: string;
  tab: string;
  effective: CrankInterval;
  inherited: boolean;
  global: CrankInterval;
  onDone: (choice: CrankInterval | null) => void;
}

export function IntervalPicker({ slug, tab, effective, inherited, global, onDone }: PickerProps) {
  const [value, setValue] = useState<CrankInterval>(effective);
  useInput((input, key) => {
    if (key.return) onDone(value);
    else if (key.escape || input === "q") onDone(null);
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={themeColor("accent")} bold>crank interval</Text>
        <Text color={themeColor("muted")}> {marks.dot} </Text>
        <Text>{slug}</Text>
        <Text color={themeColor("muted")}> {marks.pointer} </Text>
        <Text bold>{tab}</Text>
      </Text>
      <Text color={themeColor("muted")}>How often may the crank beat touch this tab? Now: {inheritanceNote(inherited, global)}.</Text>
      <Box marginY={1}>
        <RadioGroup options={intervalOptions(global)} value={value} onChange={setValue} />
      </Box>
      <KeyHints hints={[{ keys: "←/→ 1-4", label: "choose" }, { keys: "enter", label: "enable" }, { keys: "esc q", label: "abort" }]} />
    </Box>
  );
}

/** Show the picker inline. Resolves the choice, null when aborted (esc/q/ctrl-c). */
export async function pickInterval(props: Omit<PickerProps, "onDone">, run: RunInkOptions = {}): Promise<CrankInterval | null> {
  const choice = await runInk<CrankInterval | null>((finish) => <IntervalPicker {...props} onDone={finish} />, run);
  return choice ?? null;
}

// ---------------------------------------------------------------------------
// Dashboard (pj crank tui)
// ---------------------------------------------------------------------------

export interface DashboardProps {
  controller: CrankController;
  /** Re-read Redis this often (default 5s). */
  refreshMs?: number;
  /** Test seam for the countdown clock. */
  clock?: () => number;
  onQuit: () => void;
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function describeMatch(view: CrankView): string {
  const { resolution } = view;
  if (resolution.storedAsIs) return `no live tab or key matches "${view.name}" - stored under the project name`;
  const how = resolution.source.replace("-", " ");
  return resolution.liveTab ? `live tab "${resolution.liveTab}" via ${how} "${resolution.matched}"` : `stored key via ${how} "${resolution.matched}"`;
}

export function CrankDashboard({ controller, refreshMs = 5000, clock = Date.now, onQuit }: DashboardProps) {
  const [view, setView] = useState<CrankView>(() => controller.read(clock()));
  const [error, setError] = useState<string | undefined>();
  const [flash, setFlash] = useState<string | undefined>();
  const now = useNow(1000, clock);
  const { rows } = useWindowSize();

  const refresh = useCallback(() => {
    try {
      setView(controller.read(clock()));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [controller, clock]);
  useInterval(refresh, refreshMs);

  const act = (label: string, fn: () => string | void) => {
    try {
      const note = fn();
      setFlash(note || label);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    refresh();
  };

  const snap = view.snapshot;
  const isOn = snap.enabled === true;
  const toggle = () => act(isOn ? "crank OFF" : "crank ON", () => {
    if (isOn) {
      controller.disable();
      return;
    }
    const result = controller.enable();
    return result.renamed.length ? `crank ON (renamed ${result.renamed.map((r) => `${r.from} -> ${r.to}`).join(", ")})` : undefined;
  });

  useInput((input, key) => {
    if (key.escape || input === "q") onQuit();
    else if (input === " " || input === "t") toggle();
    else if (input === "r") act(`interval reset to global (${snap.global})`, () => controller.setInterval(undefined));
  });

  const onInterval = (interval: CrankInterval) => act(`interval ${interval}`, () => controller.setInterval(interval));
  const next = nextRunMs({ enabled: isOn, interval: snap.interval, lastRun: snap.lastRunMs, nowMs: now });
  const logRows = Math.max(3, (rows || 24) - 19);
  const tail = snap.log.slice(-logRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={themeColor("accent")} bold>pj crank</Text>
        <Text color={themeColor("muted")}> {marks.dot} </Text>
        <Text bold>{view.slug}</Text>
        <Text color={themeColor("muted")}> ({view.name})</Text>
      </Text>
      <Text color={themeColor("muted")} wrap="truncate-end">tab <Text color={undefined} bold>{snap.tab}</Text>  {describeMatch(view)}</Text>
      {view.resolution.storedAsIs ? <Text color={themeColor("warn")}>{`no tab matched yet - toggling stores "${snap.tab}" as-is`}</Text> : null}

      <Box marginTop={1}>
        <Text>
          <Text color={themeColor("muted")}>{"Crank      "}</Text>
          {isOn ? <Text color={themeColor("ok")} bold>{marks.dotOn} ON</Text> : <Text color={themeColor("muted")}>{marks.dotOff} OFF</Text>}
        </Text>
      </Box>
      <Box>
        <Text color={themeColor("muted")}>{"Interval   "}</Text>
        <RadioGroup options={intervalOptions(snap.global)} value={snap.interval} onChange={onInterval} />
      </Box>
      <Text color={themeColor("muted")}>{"           "}{inheritanceNote(snap.inherited, snap.global)}</Text>
      <Text>
        <Text color={themeColor("muted")}>{"Next run   "}</Text>
        {next === undefined ? <Text color={themeColor("muted")}>off</Text> : <Text>{next <= now ? "now" : `in ${formatDuration((next - now) / 1000)}`} <Text color={themeColor("muted")}>({clockTime(next)})</Text></Text>}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text color={themeColor("muted")}>Last runs</Text>
        {snap.beats.length === 0 ? <Text color={themeColor("muted")}>  none yet</Text> : snap.beats.map((beat, i) => (
          <Text key={`${beat.ts}-${i}`} wrap="truncate-end">  {formatAge(beat.tsMs, now).padEnd(10)} {beat.state.padEnd(9)} <Text color={themeColor("muted")}>{beat.action}</Text></Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={themeColor("muted")}>Log ({snap.log.length} rows)</Text>
        {tail.map((raw, i) => (
          <Text key={i} wrap="truncate-end" color={themeColor("muted")}>  {renderLogRow(raw) ?? raw}</Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {error ? <Text color={themeColor("fail")}>{`${marks.dot} ${error}`}</Text> : flash ? <Text color={themeColor("ok")}>{`${marks.dot} ${flash}`}</Text> : <Text> </Text>}
        <KeyHints hints={[
          { keys: "space t", label: "toggle" },
          { keys: "←/→ 1-4", label: "interval" },
          { keys: "r", label: "reset to global" },
          { keys: "q esc", label: "quit" },
        ]} />
      </Box>
    </Box>
  );
}

/** Run the dashboard full-screen until the operator quits. */
export async function runCrankDashboard(controller: CrankController, run: RunInkOptions & { refreshMs?: number } = {}): Promise<void> {
  const { refreshMs, ...ink } = run;
  // Read once BEFORE taking over the terminal: a store that throws on first read (Redis
  // gone, an error reply on a key) must come out as the CLI's one-line ✖, not as an Ink
  // crash frame with a code excerpt (PJAN-186). Once open, refresh()/act() show the same
  // error inline instead.
  controller.read();
  await runInk<void>((finish) => <CrankDashboard controller={controller} refreshMs={refreshMs} onQuit={() => finish()} />, { alternateScreen: true, ...ink });
}
