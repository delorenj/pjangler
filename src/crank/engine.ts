// Crank engine health (PJAN-201), read-only and advisory.
//
// The beat is Candybar job crank-beat -> Hermes cron job 777c511a009c (profile 33god-pm).
// Hermes "economics" refuses a tick once the job's ROLLING-24h token sum reaches
// max_daily_tokens, and Candybar still records the refused tick as a success with 0
// tokens: nothing looks wrong while the engine does nothing for hours. This module reads
// Hermes' own audit trail (cron/usage_audit.jsonl) and says what actually happened.
//
// Contract: NOTHING in here may throw out of a pj command. A missing / unreadable / garbage
// file means "engine status unknown" (no claim), never an exception and never a non-zero exit.
//
// The window rule mirrors hermes-agent/cron/economics.py admit(): rows with
// status completed|started and ts >= now - 24h, summed over total_tokens; refused at
// sum >= cap. Standalone on purpose (no imports from ./index) so index can re-export it.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENGINE_DEFAULT_JOB_ID = "777c511a009c";
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** The beat ticks on a 5-minute wall clock. */
const TICK_MS = 5 * 60 * 1000;
/** Older than this and the engine is not ticking at all (three missed ticks). */
const STALL_MS = 3 * TICK_MS;
/** A bounded tail: ~200KB of audit per day, so this covers days, never the whole 1.6MB+ file. */
export const ENGINE_AUDIT_TAIL_BYTES = 1024 * 1024;

export type EngineOutcome = "cranked" | "refused" | "other" | "unknown";

export interface EngineStatus {
  /** False when nothing could be read: the caller makes no claim. */
  known: boolean;
  jobId: string;
  readAtMs: number;
  outcome: EngineOutcome;
  /** Raw status of the last tick ("completed", "skipped", "failed", ...). */
  lastStatus?: string;
  lastTickMs?: number;
  /** economics_reason (or error) of the last tick when it did not run. */
  reason?: string;
  /** Start of the unbroken run of refused ticks ending at the last tick. */
  refusedSinceMs?: number;
  /** Completed + started rows in the rolling 24h, and their tokens. */
  beats24h: number;
  tokens24h: number;
  /** max_daily_tokens (jobs.json, else parsed out of the refusal reason). */
  cap?: number;
  /** The last tick was refused by the daily TOKEN limit. */
  tokenBlocked: boolean;
  /** Estimated instant the rolling sum drops below the cap (row.ts + 24h, oldest first). */
  resumeMs?: number;
}

/** "Engine status unknown": no claim about the engine. */
export function unknownEngineStatus(nowMs: number, jobId: string = ENGINE_DEFAULT_JOB_ID): EngineStatus {
  return { known: false, jobId, readAtMs: nowMs, outcome: "unknown", beats24h: 0, tokens24h: 0, tokenBlocked: false };
}

interface AuditRow {
  tsMs: number;
  status: string;
  tokens: number;
  reason?: string;
}

function parseAuditRows(text: string, jobId: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (String(record.job_id ?? "") !== jobId) continue;
    const ts = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    const tokens = Number(record.total_tokens ?? 0);
    const reasonRaw = record.economics_reason ?? record.error;
    rows.push({
      tsMs: ts,
      status: typeof record.status === "string" ? record.status : "",
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
      reason: typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim() : undefined,
    });
  }
  return rows.sort((a, b) => a.tsMs - b.tsMs);
}

/** "daily token limit reached (10,000,000)" -> 10000000. */
function capFromReason(reason: string | undefined): number | undefined {
  const match = /daily token limit reached \(([\d,]+)\)/i.exec(reason ?? "");
  if (!match) return undefined;
  const n = Number.parseInt((match[1] ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Pure: derive the engine status from audit text. `cap` is max_daily_tokens when the caller
 * could read it; otherwise it is parsed from the last refusal. Never throws.
 */
export function parseEngineStatus(auditText: string, input: { jobId?: string; cap?: number; nowMs: number }): EngineStatus {
  const jobId = input.jobId ?? ENGINE_DEFAULT_JOB_ID;
  try {
    const rows = parseAuditRows(auditText, jobId);
    const last = rows.at(-1);
    if (!last) return unknownEngineStatus(input.nowMs, jobId);

    const windowStart = input.nowMs - WINDOW_MS;
    const counted = rows.filter((r) => (r.status === "completed" || r.status === "started") && r.tsMs >= windowStart);
    const tokens24h = counted.reduce((sum, r) => sum + r.tokens, 0);

    const ran = last.status === "completed" || last.status === "started";
    const refused = !ran && last.status !== "failed" && (last.status === "skipped" || last.status === "blocked" || !!last.reason);
    const outcome: EngineOutcome = ran ? "cranked" : refused ? "refused" : "other";
    const tokenBlocked = outcome === "refused" && /daily token limit/i.test(last.reason ?? "");

    let refusedSinceMs: number | undefined;
    if (outcome === "refused") {
      refusedSinceMs = last.tsMs;
      for (let i = rows.length - 2; i >= 0; i--) {
        const r = rows[i];
        if (!r) break;
        if (r.status === "completed" || r.status === "started" || r.status === "failed") break;
        refusedSinceMs = r.tsMs;
      }
    }

    const cap = input.cap && input.cap > 0 ? input.cap : capFromReason(last.reason);
    let resumeMs: number | undefined;
    if (tokenBlocked && cap) {
      // Oldest first: the instant each row ages out of the window is row.ts + 24h; the first
      // instant the remaining sum is below the cap is the resume estimate.
      let remaining = tokens24h;
      resumeMs = remaining < cap ? input.nowMs : undefined;
      for (const row of counted) {
        if (remaining < cap) break;
        remaining -= row.tokens;
        if (remaining < cap) {
          resumeMs = row.tsMs + WINDOW_MS;
          break;
        }
      }
    }

    return {
      known: true,
      jobId,
      readAtMs: input.nowMs,
      outcome,
      lastStatus: last.status || undefined,
      lastTickMs: last.tsMs,
      reason: outcome === "cranked" ? undefined : last.reason,
      refusedSinceMs,
      beats24h: counted.length,
      tokens24h,
      cap,
      tokenBlocked,
      resumeMs,
    };
  } catch {
    return unknownEngineStatus(input.nowMs, jobId);
  }
}

/** The last `maxBytes` of a file as text, without a leading partial line. Throws on I/O error. */
function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    if (size <= maxBytes) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

export interface EngineSources {
  auditPath: string;
  jobsPath: string;
  jobId: string;
}

/** Where the audit trail and the job table live: env overrides, else the 33god-pm profile. */
export function engineSources(env: NodeJS.ProcessEnv = process.env): EngineSources {
  const cronDir = join(homedir(), ".hermes", "profiles", "33god-pm", "cron");
  return {
    auditPath: env.PJ_CRANK_USAGE_AUDIT?.trim() || join(cronDir, "usage_audit.jsonl"),
    jobsPath: join(cronDir, "jobs.json"),
    jobId: env.PJ_CRANK_JOB_ID?.trim() || ENGINE_DEFAULT_JOB_ID,
  };
}

/** max_daily_tokens for the job from jobs.json, or undefined when unreadable. */
function readCap(jobsPath: string, jobId: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(jobsPath, "utf8")) as { jobs?: unknown };
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const job = jobs.find((j): j is Record<string, unknown> => typeof j === "object" && j !== null && String((j as Record<string, unknown>).id ?? "") === jobId);
    const economics = job?.economics;
    if (typeof economics !== "object" || economics === null) return undefined;
    const cap = Number((economics as Record<string, unknown>).max_daily_tokens);
    return Number.isFinite(cap) && cap > 0 ? cap : undefined;
  } catch {
    return undefined;
  }
}

/** Read the engine status from disk. Never throws; an unreadable source is "unknown". */
export function readEngineStatus(options: { nowMs?: number; env?: NodeJS.ProcessEnv; sources?: Partial<EngineSources>; tailBytes?: number } = {}): EngineStatus {
  const nowMs = options.nowMs ?? Date.now();
  const base = engineSources(options.env);
  const sources = { ...base, ...options.sources };
  try {
    const text = readTail(sources.auditPath, options.tailBytes ?? ENGINE_AUDIT_TAIL_BYTES);
    return parseEngineStatus(text, { jobId: sources.jobId, cap: readCap(sources.jobsPath, sources.jobId), nowMs });
  } catch {
    return unknownEngineStatus(nowMs, sources.jobId);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers (plain text; callers colour)
// ---------------------------------------------------------------------------

/** Local HH:MM. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ago`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ago`;
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** The first beat tick (5-minute wall clock) at or after `ms`: when a resumed engine next acts. */
export function nextTickAtOrAfter(ms: number): number {
  return Math.ceil(ms / TICK_MS) * TICK_MS;
}

/** True when the last tick is old enough that the engine is not ticking at all. */
export function engineStalled(status: EngineStatus): boolean {
  return status.known && status.lastTickMs !== undefined && status.readAtMs - status.lastTickMs > STALL_MS;
}

/** When the engine is refusing, the text that replaces the next-run countdown; else undefined. */
export function engineBlockedLabel(status: EngineStatus): string | undefined {
  if (!status.known) return undefined;
  if (engineStalled(status) && status.lastTickMs !== undefined) return `blocked: engine not ticking (last tick ${ago(status.lastTickMs, status.readAtMs)})`;
  if (status.outcome !== "refused") return undefined;
  if (status.tokenBlocked) {
    const resume = status.resumeMs !== undefined ? ` — resumes ≈ ${clockTime(nextTickAtOrAfter(status.resumeMs))}` : "";
    return `blocked: daily token cap${resume}`;
  }
  return `blocked: ${status.reason ?? "engine refused the last tick"}`;
}

export type EngineTone = "ok" | "warn" | "unknown";

/** One line about the engine for `pj crank list` and the TUI Engine row. */
export function engineSummary(status: EngineStatus): { text: string; tone: EngineTone } {
  if (!status.known || status.lastTickMs === undefined) return { text: "engine status unknown", tone: "unknown" };
  const now = status.readAtMs;
  const usage = `${status.beats24h} beat${status.beats24h === 1 ? "" : "s"} / ${compactTokens(status.tokens24h)} tokens in 24h${status.cap ? ` of ${compactTokens(status.cap)}` : ""}`;
  const tick = `last tick ${ago(status.lastTickMs, now)}`;
  const stalled = engineStalled(status) ? " - not ticking" : "";
  if (status.outcome === "cranked") return { text: `${tick} (cranked)${stalled} · ${usage}`, tone: stalled ? "warn" : "ok" };
  if (status.outcome === "refused") {
    const since = status.refusedSinceMs !== undefined && status.refusedSinceMs < status.lastTickMs ? ` since ${ago(status.refusedSinceMs, now)}` : "";
    const resume = status.tokenBlocked && status.resumeMs !== undefined ? ` · resumes ≈ ${clockTime(nextTickAtOrAfter(status.resumeMs))}` : "";
    return { text: `REFUSING${since}: ${status.reason ?? "refused"} · ${tick}${stalled} · ${usage}${resume}`, tone: "warn" };
  }
  return { text: `${tick} (${status.lastStatus ?? "other"}${status.reason ? `: ${status.reason}` : ""})${stalled} · ${usage}`, tone: "warn" };
}
