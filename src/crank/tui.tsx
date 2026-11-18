// Ink screens for `pj crank` (PJAN-182, reworked for crank v2 in PJAN-214): the interval picker
// `pj crank enable` shows, and the full-screen dashboard behind `pj crank tui`. Built as its own
// esbuild entry (dist/crank/tui.js) and loaded lazily, so ink/react stay out of every other command.

import { Box, Text, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyHints, RadioGroup, runInk, useInterval, useNow, themeColor, marks, type RadioOption, type RunInkOptions } from "../tui";
import type { CrankController, CrankView } from "./controller";
import { CRANK_INTERVAL_CHOICES } from "./policy";

/** The radio choices, with the global default badged and a custom current value kept selectable. */
export function intervalOptions(global: string, current?: string): RadioOption<string>[] {
  const values: string[] = [...CRANK_INTERVAL_CHOICES];
  if (current && !values.includes(current)) values.push(current);
  return values.map((value) => ({ value, label: value, badge: value === global ? "global" : undefined }));
}

function inheritanceNote(inherited: boolean, global: string): string {
  return inherited ? `inherits global (${global})` : `project override (global is ${global})`;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function until(ms: number, now: number): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `in ${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// Picker (pj crank enable)
// ---------------------------------------------------------------------------

export interface PickerProps {
  slug: string;
  effective: string;
  inherited: boolean;
  global: string;
  onDone: (choice: string | null) => void;
}

export function IntervalPicker({ slug, effective, inherited, global, onDone }: PickerProps) {
  const [value, setValue] = useState<string>(effective);
  useInput((input, key) => {
    if (key.return) onDone(value);
    else if (key.escape || input === "q") onDone(null);
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={themeColor("accent")} bold>crank interval</Text>
        <Text color={themeColor("muted")}> {marks.dot} </Text>
        <Text bold>{slug}</Text>
      </Text>
      <Text color={themeColor("muted")}>How often should the crank officer check each agent session in this project? Now: {inheritanceNote(inherited, global)}.</Text>
      <Box marginY={1}>
        <RadioGroup options={intervalOptions(global, effective)} value={value} onChange={setValue} />
      </Box>
      <KeyHints hints={[{ keys: "←/→ 1-5", label: "choose" }, { keys: "enter", label: "enable" }, { keys: "esc q", label: "abort" }]} />
    </Box>
  );
}

/** Show the picker inline. Resolves the choice, null when aborted (esc/q/ctrl-c). */
export async function pickInterval(props: Omit<PickerProps, "onDone">, run: RunInkOptions = {}): Promise<string | null> {
  const choice = await runInk<string | null>((finish) => <IntervalPicker {...props} onDone={finish} />, run);
  return choice ?? null;
}

// ---------------------------------------------------------------------------
// Dashboard (pj crank tui)
// ---------------------------------------------------------------------------

export interface DashboardProps {
  controller: CrankController;
  initial: CrankView;
  /** Re-read policy + Candybar this often (default 5s). */
  refreshMs?: number;
  clock?: () => number;
  onQuit: () => void;
}

export function CrankDashboard({ controller, initial, refreshMs = 5000, clock = Date.now, onQuit }: DashboardProps) {
  const [view, setView] = useState<CrankView>(initial);
  const [error, setError] = useState<string | undefined>();
  const [flash, setFlash] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const now = useNow(1000, clock);
  const { rows } = useWindowSize();
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setView(await controller.read(clock()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inflight.current = false;
    }
  }, [controller, clock]);
  useInterval(() => void refresh(), refreshMs);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setFlash("working…");
    fn()
      .then((note) => {
        setFlash(note);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => {
        setBusy(false);
        void refresh();
      });
  };

  const { policy } = view;
  const inherited = policy.intervalSource !== "project";
  useInput((input, key) => {
    if (key.escape || input === "q") onQuit();
    else if (input === " " || input === "t") act(() => controller.toggle());
    else if (input === "r") act(() => controller.setInterval(undefined));
  });
  const onInterval = (interval: string) => act(() => controller.setInterval(interval));

  const logRows = Math.max(3, (rows || 24) - 17 - view.sessions.length * 2);
  const tail = view.log.slice(-logRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={themeColor("accent")} bold>pj crank</Text>
        <Text color={themeColor("muted")}> {marks.dot} </Text>
        <Text bold>{view.slug}</Text>
        <Text color={themeColor("muted")}> {view.root}</Text>
      </Text>

      <Box marginTop={1}>
        <Text>
          <Text color={themeColor("muted")}>{"Crank      "}</Text>
          {policy.enabled ? <Text color={themeColor("ok")} bold>{marks.dotOn} ON</Text> : <Text color={themeColor("muted")}>{marks.dotOff} OFF</Text>}
          <Text color={themeColor("muted")}>  {policy.enabledSource === "project" ? "set in .project.json" : `inherited from ${policy.enabledSource === "global" ? "global crank.toml" : "built-in default"}`}</Text>
        </Text>
      </Box>
      <Box>
        <Text color={themeColor("muted")}>{"Interval   "}</Text>
        <RadioGroup options={intervalOptions(view.globalInterval, policy.interval)} value={policy.interval} onChange={onInterval} isActive={!busy} />
      </Box>
      <Text color={themeColor("muted")}>{"           "}{inheritanceNote(inherited, view.globalInterval)}</Text>
      {policy.prompt ? <Text wrap="truncate-end"><Text color={themeColor("muted")}>{"Officer    "}</Text>{policy.prompt}</Text> : <Text color={themeColor("muted")}>{"Officer    "}no project prompt (crank.prompt): just keep them going</Text>}
      {policy.target ? <Text wrap="truncate-end"><Text color={themeColor("muted")}>{"Target     "}</Text>{policy.target}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color={themeColor("muted")}>Sessions (one crank per live agent session; each is its own Candybar)</Text>
        {!view.sessionsReadable ? <Text color={themeColor("warn")}>  Candybar unreadable: {view.sessionsError}</Text>
          : view.sessions.length === 0 ? <Text color={themeColor("muted")}>  none{policy.enabled ? " yet: each agent session that starts here gets one" : ""}</Text>
          : view.sessions.map((s) => {
            const last = s.lastRuns[0];
            return (
              <Box key={s.name} flexDirection="column">
                <Text wrap="truncate-end">
                  {"  "}
                  {s.alive ? <Text color={themeColor("ok")}>{marks.dotOn}</Text> : <Text color={themeColor("fail")}>{marks.dotOff}</Text>}
                  {" "}<Text bold>{s.cli}</Text> <Text>{s.sessionId.slice(0, 8)}</Text>
                  <Text color={themeColor("muted")}> pane terminal_{s.paneId} · every {s.interval || "?"}</Text>
                </Text>
                <Text wrap="truncate-end" color={themeColor("muted")}>
                  {"      "}last {last ? `${last.result} ${ago(Date.parse(last.startedAt), now)}` : "never"} · next {s.nextFireMs ? until(s.nextFireMs, now) : "?"}
                  {s.lastClass ? ` · saw ${s.lastClass}` : ""}{s.officerLast ? ` · officer ${s.officerLast.class} ${ago(Date.parse(s.officerLast.ts), now)}` : ""}
                </Text>
              </Box>
            );
          })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={themeColor("muted")}>Engine log ({view.log.length} rows)</Text>
        {tail.length === 0 ? <Text color={themeColor("muted")}>  no fires yet</Text> : tail.map((row, i) => (
          <Text key={`${row.ts}-${i}`} wrap="truncate-end" color={themeColor("muted")}>  {row.ts.slice(11, 19)} {row.binding.replace(/^crank-/, "")} {row.state.padEnd(9)} {row.action}</Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {error ? <Text color={themeColor("fail")}>{`${marks.dot} ${error}`}</Text> : flash ? <Text color={themeColor("ok")}>{`${marks.dot} ${flash}`}</Text> : <Text> </Text>}
        <KeyHints hints={[
          { keys: "space t", label: "toggle project" },
          { keys: "←/→ 1-5", label: "interval" },
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
  // Read once BEFORE taking over the terminal: a policy that cannot be read must come out as the
  // CLI's one-line ✖, not as an Ink crash frame (PJAN-186).
  const initial = await controller.read();
  await runInk<void>((finish) => <CrankDashboard controller={controller} initial={initial} refreshMs={refreshMs} onQuit={() => finish()} />, { alternateScreen: true, ...ink });
}
