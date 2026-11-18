// Crank v2 policy (PJAN-214): WHETHER and HOW OFTEN agent sessions in a project get cranked.
//
// Two layers, resolved with provenance like the notebook block:
//   - the project's `.project.json` `crank` block   { enabled, interval, prompt, target, rules }
//   - the install's `$XDG_CONFIG_HOME/33god/crank.toml` (enabled_by_default, default_interval, …)
// A project block value always wins; an absent one falls back to the global file, then to the
// built-in default. Unknown keys in either layer are preserved, so later fields (triggers,
// alerts) can land without a migration.
//
// The project block is the standing opt-in for every interactive agent session that starts in
// the project (recorded against I-8 AD-3 on 2026-11-18). A session is never cranked because of
// a tab name or a pane: see ./binding for the session-keyed half.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** The radio choices the TUI and the `enable` picker offer. Any `<N>m|<N>h|1d` is accepted on the CLI. */
export const CRANK_INTERVAL_CHOICES = ["5m", "15m", "1h", "6h", "1d"] as const;
export const DEFAULT_INTERVAL = "5m";
export const DEFAULT_OFFICER_PROFILE = "33god-pm";
export const DEFAULT_OFFICER_MAX_TURNS = 6;
const DEFAULT_ZELLIJ_SESSION = "Workspace";

export interface CrankProjectBlock {
  [key: string]: unknown;
  enabled?: boolean;
  interval?: string;
  /** Guidance for the crank officer: how to steer agents in this project. */
  prompt?: string;
  /** What "done" looks like for this project, so the officer can tell progress from drift. */
  target?: string;
  rules?: string[];
}

export interface CrankGlobalConfig {
  [key: string]: unknown;
  enabled_by_default?: boolean;
  default_interval?: string;
  /** The one zellij session cranks may drive. */
  zellij_session?: string;
  /** Hermes profile the officer runs as. */
  officer_profile?: string;
  officer_max_turns?: number;
  /** Fallback officer guidance for projects whose block has no prompt. */
  prompt?: string;
}

export type ValueSource = "project" | "global" | "default";

export interface EffectiveCrankPolicy {
  enabled: boolean;
  enabledSource: ValueSource;
  interval: string;
  intervalSource: ValueSource;
  prompt?: string;
  promptSource?: ValueSource;
  target?: string;
  rules: string[];
  zellijSession: string;
  officerProfile: string;
  officerMaxTurns: number;
  globalPath: string;
  /** True when the project block exists at all (even `{}`). */
  declared: boolean;
}

export class CrankPolicyError extends Error {}

// ---------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------

/** Normalised interval (`15m`, `2h`, `1d`) or undefined. Candybar's floor is one minute. */
export function normaliseInterval(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = /^\s*(\d+)\s*(m|min|h|hr|d|day)\s*$/i.exec(raw);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase().charAt(0);
  if (unit === "m" && n >= 1 && n <= 59) return `${n}m`;
  if (unit === "h" && n >= 1 && n <= 23) return `${n}h`;
  if (unit === "d" && n === 1) return "1d";
  return undefined;
}

export function intervalSeconds(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : 86400;
}

/** Small stable hash, used to stagger cranks so N sessions do not all fire on the same minute. */
export function stagger(seed: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h % modulo;
}

/** The 5-field cron for an interval, phase-shifted by `seed` (Candybar rejects hashed H fields). */
export function intervalCron(interval: string, seed: string): string {
  const norm = normaliseInterval(interval);
  if (!norm) throw new CrankPolicyError(`not an interval: "${interval}" (use <N>m, <N>h or 1d)`);
  const n = Number(norm.slice(0, -1));
  const unit = norm.slice(-1);
  const minute = stagger(seed, 60);
  if (unit === "m") {
    if (n === 1) return "* * * * *";
    return `${minute % n}-59/${n} * * * *`;
  }
  if (unit === "h") {
    if (n === 1) return `${minute} * * * *`;
    return `${minute} ${stagger(`${seed}:h`, n)}-23/${n} * * *`;
  }
  return `${minute} ${9 + stagger(`${seed}:d`, 10)} * * *`;
}

// ---------------------------------------------------------------------------
// Next fire for the cron shapes intervalCron() writes (host-local wall clock)
// ---------------------------------------------------------------------------

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const [range = "*", stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 59;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else {
      lo = Number(range);
      hi = stepRaw ? 59 : lo;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Next minute matching a `m h * * *` cron after `nowMs`, scanning at most two days. */
export function nextFire(cron: string, nowMs: number): number | undefined {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (!minute || !hour || dom !== "*" || month !== "*" || dow !== "*") return undefined;
  const start = new Date(nowMs);
  start.setSeconds(0, 0);
  for (let i = 1; i <= 2 * 24 * 60; i++) {
    const at = new Date(start.getTime() + i * 60_000);
    if (fieldMatches(minute, at.getMinutes()) && fieldMatches(hour, at.getHours())) return at.getTime();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Global config ($XDG_CONFIG_HOME/33god/crank.toml)
// ---------------------------------------------------------------------------

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "33god", "crank.toml");
}

export function readGlobalConfig(path = globalConfigPath()): CrankGlobalConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = parseToml(readFileSync(path, "utf8"));
    return parsed as CrankGlobalConfig;
  } catch (error) {
    throw new CrankPolicyError(`${path} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeGlobalConfig(config: CrankGlobalConfig, path = globalConfigPath()): void {
  const header = "# Crank install defaults (pj crank config --global). Project .project.json `crank` blocks override these.\n";
  atomicWrite(path, header + stringifyToml(config) + "\n");
}

// ---------------------------------------------------------------------------
// Project block (.project.json `crank`)
// ---------------------------------------------------------------------------

export function projectManifestPath(root: string): string {
  return join(root, ".project.json");
}

export function readProjectBlock(root: string): CrankProjectBlock | undefined {
  const path = projectManifestPath(root);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const block = manifest.crank;
  if (block === undefined) return undefined;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new CrankPolicyError(`${path}: "crank" must be an object`);
  }
  return block as CrankProjectBlock;
}

/** Apply `edit` to the block (undefined removes it) and rewrite .project.json, keeping its key order. */
export function updateProjectBlock(root: string, edit: (block: CrankProjectBlock) => CrankProjectBlock | undefined): CrankProjectBlock | undefined {
  const path = projectManifestPath(root);
  const text = readFileSync(path, "utf8");
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const current = (manifest.crank && typeof manifest.crank === "object" ? { ...(manifest.crank as CrankProjectBlock) } : {}) as CrankProjectBlock;
  const next = edit(current);
  if (next === undefined || Object.keys(next).length === 0) delete manifest.crank;
  else manifest.crank = next;
  const indent = /^\{\n(\s+)"/.exec(text)?.[1] ?? "  ";
  atomicWrite(path, JSON.stringify(manifest, null, indent) + "\n");
  return next;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolvePolicy(project: CrankProjectBlock | undefined, global: CrankGlobalConfig, globalPath = globalConfigPath()): EffectiveCrankPolicy {
  const block = project ?? {};
  const enabled: [boolean, ValueSource] = typeof block.enabled === "boolean"
    ? [block.enabled, "project"]
    : typeof global.enabled_by_default === "boolean" ? [global.enabled_by_default, "global"] : [false, "default"];
  const projectInterval = normaliseInterval(block.interval);
  const globalInterval = normaliseInterval(global.default_interval);
  const interval: [string, ValueSource] = projectInterval
    ? [projectInterval, "project"]
    : globalInterval ? [globalInterval, "global"] : [DEFAULT_INTERVAL, "default"];
  const prompt = str(block.prompt) ? ([str(block.prompt), "project"] as const) : str(global.prompt) ? ([str(global.prompt), "global"] as const) : undefined;
  const turns = Number(global.officer_max_turns);
  return {
    enabled: enabled[0],
    enabledSource: enabled[1],
    interval: interval[0],
    intervalSource: interval[1],
    prompt: prompt?.[0],
    promptSource: prompt?.[1],
    target: str(block.target),
    rules: Array.isArray(block.rules) ? block.rules.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "") : [],
    zellijSession: str(global.zellij_session) ?? process.env.ZCRANK_SESSION?.trim() ?? DEFAULT_ZELLIJ_SESSION,
    officerProfile: str(global.officer_profile) ?? DEFAULT_OFFICER_PROFILE,
    officerMaxTurns: Number.isInteger(turns) && turns > 0 && turns <= 20 ? turns : DEFAULT_OFFICER_MAX_TURNS,
    globalPath,
    declared: project !== undefined,
  };
}

export function loadPolicy(root: string, globalPath = globalConfigPath()): EffectiveCrankPolicy {
  return resolvePolicy(readProjectBlock(root), readGlobalConfig(globalPath), globalPath);
}

// ---------------------------------------------------------------------------
// `pj crank config` key editing
// ---------------------------------------------------------------------------

export const PROJECT_KEYS = ["enabled", "interval", "prompt", "target", "rules"] as const;
export const GLOBAL_KEYS = ["enabled_by_default", "default_interval", "zellij_session", "officer_profile", "officer_max_turns", "prompt"] as const;

function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(v)) return true;
  if (["false", "off", "no", "0"].includes(v)) return false;
  throw new CrankPolicyError(`expected true/false, got "${raw}"`);
}

/** Typed value for a key, or a CrankPolicyError naming what is wrong. */
export function coerceValue(key: string, raw: string): unknown {
  switch (key) {
    case "enabled":
    case "enabled_by_default":
      return parseBool(raw);
    case "interval":
    case "default_interval": {
      const norm = normaliseInterval(raw);
      if (!norm) throw new CrankPolicyError(`"${raw}" is not an interval (use <N>m with N<=59, <N>h with N<=23, or 1d)`);
      return norm;
    }
    case "officer_max_turns": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new CrankPolicyError("officer_max_turns must be an integer 1-20");
      return n;
    }
    case "rules": {
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new CrankPolicyError("rules must be a JSON array of strings");
        return parsed;
      }
      return trimmed.split(/\n|;/).map((rule) => rule.trim()).filter(Boolean);
    }
    default:
      return raw;
  }
}
