// Crank-mode switches, project-native (PJAN-174).
//
// The crank engine is zcrank.py + zcrankctl (~/.local/bin), which decide per
// zellij tab whether the operator's crank beat may touch a tab. That state is
// Redis (localhost:6379, db 0): zcrank:tab:<tab> hash {enabled: 0|1},
// zcrank:pane:<tab>:<terminal_id> string overrides, zcrank:log:<tab> JSON rows
// (ts/state/action) capped at 500. This module is the pjangler-side face of
// the same switches: it never edits those scripts and never invents a second
// store — it shells out to `redis-cli --raw` and `zellij ... list-tabs
// --json` exactly the way zcrankctl does, and writes the same keys.
//
// What pjangler adds on top is the project mapping. zcrankctl is tab-native
// (you name a tab); `pj crank` is project-native (you stand in a repo). A
// project maps onto a tab by name only — nothing else correlates them — so:
//
//   1. exact canonical match against a live zellij tab,
//   2. exact canonical match against an existing zcrank:tab:* key,
//   3. prefix match either way against a live tab (zcrankctl's fuzzy rule),
//   4. else the project's own name, stored as-is, and the operator is told.
//
// Tab names carry status suffixes (gruvato 🟢, ...) in zellij; zcrankctl
// strips them before storing, so canon() here strips the same characters.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, type ProjectHandle } from "../project/boardQuery";
import { cyan, dim, green, heading } from "../utils/style";

export const ZCRANK_REDIS_HOST = "127.0.0.1";
export const ZCRANK_REDIS_PORT = 6379;
export const ZCRANK_SESSION = "Workspace";
export const ZCRANK_LOG_CAP = 500;

/** Trailing status glyphs and separators zellij appends to tab names. */
const TAB_STATUS_SUFFIX = /[\s🟢🟡🔴✳✻●·─]+$/u;

/** Command runner seam: tests substitute this to fake redis-cli/zellij. */
export type Shell = (command: string, args: string[]) => { stdout: string; status: number };

export const defaultShell: Shell = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { stdout: "", status: 127 };
  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
};

/** Strip a live tab name's status suffix (same rule as zcrankctl). */
export function tabDisplay(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return TAB_STATUS_SUFFIX.test(trimmed) ? trimmed.replace(TAB_STATUS_SUFFIX, "").trim() : trimmed;
}

/** Canonical comparison key: display form, lowercased. */
export function canon(name: string | undefined): string {
  return tabDisplay(name).toLowerCase();
}

// ---------------------------------------------------------------------------
// redis-cli --raw (no client dependency; pjangler adds none)
// ---------------------------------------------------------------------------

export function redis(deps: { shell?: Shell; host?: string; port?: number } = {}) {
  const shell = deps.shell ?? defaultShell;
  const host = deps.host ?? ZCRANK_REDIS_HOST;
  const port = deps.port ?? ZCRANK_REDIS_PORT;
  const run = (...args: string[]): string =>
    shell("redis-cli", ["--raw", "-h", host, "-p", String(port), ...args]).stdout.replace(/\r?\n$/, "");
  return {
    /** PING -> true only when Redis answers PONG. */
    ping: (): boolean => run("PING") === "PONG",
    /** HGET zcrank:tab:<tab> enabled -> "0"|"1"|undefined (absent). */
    tabEnabled: (tab: string): string | undefined => {
      const v = run("HGET", `zcrank:tab:${tab}`, "enabled");
      return v === "" || v == null ? undefined : v;
    },
    /** HSET zcrank:tab:<tab> enabled 0|1. */
    setTabEnabled: (tab: string, enabled: boolean): void => {
      run("HSET", `zcrank:tab:${tab}`, "enabled", enabled ? "1" : "0");
    },
    /** All zcrank:tab:* keys (raw key per line). */
    tabKeys: (): string[] =>
      run("KEYS", "zcrank:tab:*").split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean),
    /** RPUSH a log row, then LTRIM to the zcrankctl cap. */
    pushLog: (tab: string, state: string, action: string, ts: string): void => {
      run("RPUSH", `zcrank:log:${tab}`, JSON.stringify({ ts, state, action }));
      run("LTRIM", `zcrank:log:${tab}`, String(-ZCRANK_LOG_CAP), "-1");
    },
    /** LRANGE 0 -1, oldest first (newest last) — zcrankctl's display order. */
    logRows: (tab: string): string[] =>
      run("LRANGE", `zcrank:log:${tab}`, "0", "-1").split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// zellij live tabs
// ---------------------------------------------------------------------------

export interface LiveTab {
  name: string;
  position: number;
}

/**
 * Live zellij tab names for the Workspace session.
 *
 * `env -u ZELLIJ -u ZELLIJ_SESSION_NAME` is required — zellij refuses to
 * operate on itself when invoked from inside a pane — and `timeout 5s`
 * bounds a wedged daemon, both copied from zcrankctl.
 */
export function liveTabs(deps: { shell?: Shell } = {}): LiveTab[] {
  const shell = deps.shell ?? defaultShell;
  const result = shell("env", [
    "-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME",
    "timeout", "5s", "zellij", "-s", ZCRANK_SESSION, "action", "list-tabs", "--json",
  ]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({ name: String(entry.name ?? ""), position: Number(entry.position ?? 0) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Project → tab resolution
// ---------------------------------------------------------------------------

export type TabSource = "live-exact" | "redis-exact" | "live-prefix" | "project-name";

export interface TabResolution {
  /** The name stored under zcrank:tab:<this>. */
  tab: string;
  source: TabSource;
  /** Which candidate name matched ("agent:<handle>" for agent-derived matches). */
  matched: string;
  /** True when no live tab and no Redis key matched, so the project name was stored as-is. */
  storedAsIs: boolean;
}

/** A project's candidate names for tab matching, in precedence order. */
export interface ProjectNames {
  /** The registry record's display name (or manifest project_name). */
  name: string;
  /** Agent handles with their roles, e.g. { handle: "pile-of-dumb-things-pm", role: "pm" }. */
  agents: { handle: string; role: string }[];
}

/**
 * Every name a project may legitimately answer to on a zellij tab.
 *
 * Tabs are named after the WORK (the operator's own words: "Pile of Dumb
 * Things"), while the registry record may carry the formal project name
 * ("Tower of Lost Things"). The agent handles minted at init —
 * `<tab-slug>-<role>` — are the bridge: "pile-of-dumb-things-pm" minus its
 * role suffix slugifies to exactly the tab's canonical name.
 */
export function candidateNames(project: ProjectNames): string[] {
  const out = [project.name.trim()].filter(Boolean);
  for (const agent of project.agents) {
    const handle = (agent.handle ?? "").trim();
    if (!handle) continue;
    const role = (agent.role ?? "").trim().toLowerCase();
    const base = role && handle.toLowerCase().endsWith(`-${role}`)
      ? handle.slice(0, handle.length - role.length - 1)
      : handle;
    const spaced = base.replace(/[-_]+/g, " ").trim();
    if (spaced && !out.some((existing) => canon(existing) === canon(spaced))) out.push(spaced);
  }
  return out;
}

/**
 * Resolve which zcrank tab a project owns, trying every candidate name
 * through zcrankctl's ladder: live-exact, redis-exact, live-prefix, then
 * the project's own name stored as-is. Never throws for a miss.
 */
export function resolveTabForProject(
  project: ProjectNames,
  live: LiveTab[],
  storedTabs: string[],
): TabResolution {
  const candidates = candidateNames(project);
  // 1. Exact match on a live tab (live is the authority).
  for (const candidate of candidates) {
    for (const tab of live) {
      if (canon(tab.name) === canon(candidate)) {
        return { tab: tabDisplay(tab.name), source: "live-exact", matched: candidate, storedAsIs: false };
      }
    }
  }
  // 2. Exact match on an existing zcrank:tab:* key (a tab that was cranked
  //    before but is not open now keeps its stored name).
  for (const candidate of candidates) {
    for (const stored of storedTabs) {
      if (canon(stored) === canon(candidate)) {
        return { tab: stored, source: "redis-exact", matched: candidate, storedAsIs: false };
      }
    }
  }
  // 3. Prefix match either way against a live tab (zcrankctl's fuzzy rule).
  for (const candidate of candidates) {
    const canonical = canon(candidate);
    for (const tab of live) {
      const tabCanonical = canon(tab.name);
      if (tabCanonical.startsWith(canonical) || canonical.startsWith(tabCanonical)) {
        return { tab: tabDisplay(tab.name), source: "live-prefix", matched: candidate, storedAsIs: false };
      }
    }
  }
  // 4. Nothing matches: store the project's own name and say so.
  return { tab: tabDisplay(project.name), source: "project-name", matched: project.name, storedAsIs: true };
}

/** A project's display name: registry record first, then the manifest, then the slug. */
export function projectNameFor(handle: ProjectHandle, registryName?: string): string {
  if (registryName && registryName.trim()) return registryName.trim();
  try {
    const manifest = JSON.parse(readFileSync(join(handle.root, ".project.json"), "utf8")) as Record<string, unknown>;
    const name = manifest.project_name;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // fall through
  }
  return handle.slug;
}

/** Agent handles with roles for a project root: registry record first, then the manifest. */
export function projectAgentsFor(handle: ProjectHandle, registryAgents?: Record<string, { role?: string }>): { handle: string; role: string }[] {
  const fromRecord = Object.entries(registryAgents ?? {})
    .map(([agentHandle, value]) => ({ handle: agentHandle, role: String(value?.role ?? "") }));
  if (fromRecord.length) return fromRecord;
  try {
    const manifest = JSON.parse(readFileSync(join(handle.root, ".project.json"), "utf8")) as Record<string, unknown>;
    const agents = manifest.agents;
    if (agents && typeof agents === "object" && !Array.isArray(agents)) {
      return Object.entries(agents as Record<string, { role?: unknown }>)
        .map(([agentHandle, value]) => ({ handle: agentHandle, role: typeof value?.role === "string" ? value.role : "" }));
    }
  } catch {
    // fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// Registry view (pj crank list)
// ---------------------------------------------------------------------------

export interface CrankListRow {
  slug: string;
  name: string;
  tab: string;
  crank: "ON" | "OFF" | "—";
  source: TabSource;
}

export interface CrankListReport {
  rows: CrankListRow[];
  orphans: { tab: string; enabled: boolean }[];
}

export interface CrankProjectRecord {
  slug: string;
  name: string;
  repoPath: string;
  /** Agent handles with roles, used as extra tab-name candidates. */
  agents: { handle: string; role: string }[];
}

/** Build the crank list from registry projects plus live/stored tab state. */
export function buildCrankList(input: {
  projects: CrankProjectRecord[];
  live: LiveTab[];
  storedTabs: string[];
  tabEnabled: (tab: string) => string | undefined;
}): CrankListReport {
  const rows: CrankListRow[] = [];
  const consumed = new Set<string>();
  for (const project of input.projects) {
    const resolution = resolveTabForProject(project, input.live, input.storedTabs);
    consumed.add(canon(resolution.tab));
    const enabled = input.tabEnabled(resolution.tab);
    rows.push({
      slug: project.slug,
      name: project.name,
      tab: resolution.tab,
      crank: enabled === "1" ? "ON" : enabled === "0" ? "OFF" : "—",
      source: resolution.source,
    });
  }
  const orphans = input.storedTabs
    .filter((stored) => !consumed.has(canon(stored)))
    .map((stored) => ({ tab: stored, enabled: input.tabEnabled(stored) === "1" }));
  return { rows, orphans };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `2026-10-20T12:34:56Z`-shaped UTC stamp, matching zcrankctl's log rows. */
export function crankTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One log row as `ts  state  action`, or null when the row is not JSON. */
export function renderLogRow(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown; state?: unknown; action?: unknown };
    const ts = typeof parsed.ts === "string" ? parsed.ts : "";
    const state = typeof parsed.state === "string" ? parsed.state : "?";
    const action = typeof parsed.action === "string" ? parsed.action : "";
    return `${ts}  ${state.padEnd(12)}${action}`;
  } catch {
    return null;
  }
}

export function formatCrankList(report: CrankListReport): string {
  const lines: string[] = [""];
  lines.push(`  ${heading("Crank by project")}`);
  lines.push("");
  const slugWidth = Math.max("PROJECT".length, ...report.rows.map((row) => row.slug.length));
  const tabWidth = Math.max("TAB".length, ...report.rows.map((row) => row.tab.length), ...report.orphans.map((orphan) => orphan.tab.length));
  lines.push(`  ${"PROJECT".padEnd(slugWidth)}  ${"TAB".padEnd(tabWidth)}  CRANK`);
  for (const row of report.rows) {
    const state = row.crank === "ON" ? green("ON") : row.crank === "OFF" ? dim("OFF") : dim("—");
    lines.push(`  ${cyan(row.slug.padEnd(slugWidth))}  ${row.tab.padEnd(tabWidth)}  ${state}`);
  }
  if (report.orphans.length) {
    lines.push("");
    lines.push(`  ${dim("zcrank keys with no matching project")}`);
    for (const orphan of report.orphans) {
      lines.push(`  ${" ".repeat(slugWidth)}  ${orphan.tab.padEnd(tabWidth)}  ${orphan.enabled ? green("ON") : dim("OFF")}  ${dim("(no project)")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
