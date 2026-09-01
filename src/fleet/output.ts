// Machine and human output for `pjangler fleet ...`.
//
// A sibling of the notebook envelope rather than a reuse of it: the notebook
// envelope's `project` and `notebook` root blocks are mandatory and its command
// set is closed (`src/notebook/output.ts`). A fleet contract is not
// project-scoped, so borrowing that shape would either loosen the notebook's
// guarantees or force a fake project onto every fleet answer. The guarantees
// themselves -- bounded strings, capped details, ok <=> error === null, one
// complete document -- are reproduced here deliberately.

import { homedir, userInfo } from "node:os";
import {
  FLEET_ERROR_CODES,
  FLEET_SCHEMA_VERSION,
  FleetError,
  fleetExitCode,
  type FleetDiagnostic,
  type FleetErrorCode,
  type FleetExtension,
} from "./types";
import { bold, cyan, dim, glyph, gray, green, joinDot, padVisible, red, statusStyle, yellow } from "../utils/style";

/** Commands allowed to produce a fleet envelope. */
export const FLEET_COMMANDS = ["fleet.contract.validate"] as const;

const MAX_STRING = 512;
const MAX_DETAILS = 20;
const MAX_NEXT_ACTIONS = 20;

export interface FleetEnvelopeV1<T = unknown> {
  schema_version: 1;
  ok: boolean;
  command: string;
  data: T | null;
  error: null | {
    code: FleetErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
  next_actions: string[];
}

export interface FleetAuthorityView {
  id: string;
  owner: string;
  store: string;
  store_env: string[];
  read_only: boolean;
  writable_fields: string[];
  notes: string[];
}

export interface FleetProjectionView {
  field: string;
  source: string;
  target: string;
  direction: string;
  writable_by: string;
}

export interface FleetClassificationView {
  id: string;
  required_fields: string[];
  entry_count: number;
  entries: Array<Record<string, unknown>>;
}

export interface FleetRetiredView {
  id: string;
  reason: string;
  superseded_by: string;
  detect: string[];
}

/** Everything `fleet contract validate` learned, in one bounded shape. */
export interface FleetContractInspection {
  contract_path: string;
  byte_stable: boolean;
  schema_version: number | null;
  contract_version: string | null;
  compatibility: { min_schema_version: number; max_schema_version: number } | null;
  supported_schema_versions: { min: number; max: number };
  authorities: FleetAuthorityView[];
  projections: FleetProjectionView[];
  classifications: FleetClassificationView[];
  service_model: Record<string, unknown> | null;
  activation: Record<string, unknown> | null;
  retired: FleetRetiredView[];
  extensions: FleetExtension[];
  /** Dotted paths where an envelope bound clipped the reported value. */
  truncated: string[];
  diagnostics: FleetDiagnostic[];
}

/** Strip control characters and cap length. Same rule as the notebook envelope. */
export function bounded(value: string, max = MAX_STRING): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}

/**
 * Every home directory this process might be describing, longest first.
 *
 * `os.homedir()` alone is not enough: on POSIX it just reports `$HOME`, so
 * under an isolated test HOME, a systemd unit, or a CI runner with HOME
 * rewritten it points somewhere the reported path is not under -- and the
 * redaction silently stops redacting exactly where it matters most.
 * `os.userInfo().homedir` reads the passwd entry and ignores `$HOME`, so the
 * two together cover both. Longest first so a scratch HOME nested inside the
 * real one wins over its own parent.
 */
function homeCandidates(): string[] {
  const candidates = new Set<string>();
  try { if (homedir()) candidates.add(homedir()); } catch { /* no home is a valid state */ }
  try { if (userInfo().homedir) candidates.add(userInfo().homedir); } catch { /* container with no passwd entry */ }
  return [...candidates].sort((a, b) => b.length - a.length);
}

/**
 * Replace the operator's home directory with `~`.
 *
 * The report has to name the file it validated -- an operator cannot fix a
 * contract they cannot find -- but an absolute path under a home directory
 * carries the account name into logs, CI output, and pasted transcripts.
 * Naming the file and naming the machine are separable, so they are separated:
 * a known home collapses to `~`, and any other home-shaped prefix keeps its
 * shape but loses the account, rather than being passed through intact.
 */
export function redactHome(path: string, homes: readonly string[] = homeCandidates()): string {
  for (const home of homes) {
    if (!home) continue;
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  }
  return path.replace(/^\/(home|Users)\/[^/]+/u, "/$1/<redacted>");
}

/**
 * Where a bound was actually applied, so a caller is never quietly short-changed.
 *
 * Bounds are non-negotiable -- an envelope has to stay one document a pipe can
 * carry -- but silently dropping the 51st key while reporting "extensions
 * survive verbatim" would be a lie the caller has no way to detect. Every clip
 * records its dotted path here and the command surfaces the list.
 */
export interface BoundedContext {
  truncated: string[];
}

export function boundedContext(): BoundedContext {
  return { truncated: [] };
}

const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ITEMS = 100;

/** Keep an open-keyed contract subtree inside the envelope's bounds. */
export function boundedValue(value: unknown, context: BoundedContext = boundedContext(), path = "", depth = 0): unknown {
  const clip = (reason: string): void => { if (!context.truncated.includes(`${path}: ${reason}`)) context.truncated.push(`${path}: ${reason}`); };
  if (depth > MAX_DEPTH) { clip(`nesting deeper than ${MAX_DEPTH} levels dropped`); return null; }
  if (typeof value === "string") {
    const result = bounded(value);
    if (result.length < value.length) clip(`string clipped to ${MAX_STRING} characters`);
    return result;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) clip(`${value.length - MAX_ITEMS} of ${value.length} items dropped`);
    return value.slice(0, MAX_ITEMS).map((item, index) => boundedValue(item, context, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_KEYS) clip(`${entries.length - MAX_KEYS} of ${entries.length} keys dropped`);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_KEYS)) {
      const child = path ? `${path}.${key}` : key;
      result[bounded(key, 128)] = boundedValue(item, context, child, depth + 1);
    }
    return result;
  }
  clip("value of an unrepresentable type dropped");
  return null;
}

/**
 * Ignore a closed stdout instead of dying on it.
 *
 * `pj fleet contract validate --json | head -1` closes the pipe mid-write. With
 * no handler that surfaces as an unhandled EPIPE and a stack trace -- from a
 * command whose entire contract is "one clean document, no stack traces".
 */
export function ignoreBrokenPipe(stream: NodeJS.WriteStream = process.stdout): void {
  stream.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
}

export function normalizeFleetError(error: unknown): FleetError {
  if (error instanceof FleetError) return error;
  // Unknown exceptions are not an operator-facing protocol: runtime, parser and
  // filesystem messages routinely carry absolute paths and payload fragments.
  // Keep the original as an in-memory cause and expose one stable category.
  return new FleetError("INTERNAL_ERROR", "Fleet command encountered an unexpected internal error", false, {}, { cause: error });
}

export function fleetSuccessEnvelope<T>(command: string, data: T, nextActions: string[] = []): FleetEnvelopeV1<T> {
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    error: null,
    next_actions: nextActions.slice(0, MAX_NEXT_ACTIONS).map((item) => bounded(item)),
  };
}

export function fleetFailureEnvelope(command: string, error: unknown, nextActions: string[] = []): FleetEnvelopeV1<never> {
  const normalized = normalizeFleetError(error);
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    ok: false,
    command,
    data: null,
    error: {
      code: normalized.code,
      message: bounded(normalized.message),
      retryable: normalized.retryable,
      details: sanitizeDetails(normalized.details),
    },
    next_actions: nextActions.slice(0, MAX_NEXT_ACTIONS).map((item) => bounded(item)),
  };
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, MAX_DETAILS)) {
    if (!key) continue;
    if (typeof value === "string") result[bounded(key, 128)] = bounded(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[bounded(key, 128)] = value;
  }
  return result;
}

/**
 * Turn ordered diagnostics into a bounded, scalar-only `details` map.
 *
 * Prefixed with the index so two findings on the same path cannot collapse into
 * one, which is how a "1 finding" report would silently understate a "2
 * findings" contract.
 */
export function diagnosticDetails(diagnostics: readonly FleetDiagnostic[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const details: Record<string, unknown> = { ...extra, diagnostic_count: diagnostics.length };
  const room = MAX_DETAILS - Object.keys(details).length;
  diagnostics.slice(0, Math.max(0, room)).forEach((diagnostic, index) => {
    details[`${index}:${diagnostic.path}`] = `${diagnostic.code}: ${diagnostic.message}`;
  });
  return details;
}

export function renderFleetJson(envelope: FleetEnvelopeV1): string {
  validateFleetEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function fleetEnvelopeExitCode(envelope: FleetEnvelopeV1): number {
  return envelope.ok || !envelope.error ? 0 : fleetExitCode(envelope.error.code);
}

export function validateFleetEnvelope(envelope: FleetEnvelopeV1): void {
  const invalid = (reason: string): never => {
    throw new FleetError("INTERNAL_ERROR", `Fleet command produced an invalid JSON v1 envelope: ${reason}`);
  };
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) invalid("root must be an object");
  const keys = Object.keys(envelope).sort();
  const expected = ["command", "data", "error", "next_actions", "ok", "schema_version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid("root fields differ from v1");
  if (envelope.schema_version !== FLEET_SCHEMA_VERSION) invalid("schema version is invalid");
  if (typeof envelope.ok !== "boolean") invalid("ok is invalid");
  if (!(FLEET_COMMANDS as readonly string[]).includes(envelope.command)) invalid("command is invalid");
  if (!Array.isArray(envelope.next_actions) || envelope.next_actions.length > MAX_NEXT_ACTIONS) invalid("next_actions is invalid");
  for (const action of envelope.next_actions) if (typeof action !== "string" || action.length === 0) invalid("next_actions entry is invalid");
  if (envelope.ok === (envelope.error !== null) || (envelope.ok ? envelope.data === null : envelope.data !== null)) invalid("success/error invariant failed");
  if (envelope.ok) {
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) invalid("data must be an object");
    for (const key of ["contract_path", "authorities", "projections", "classifications", "service_model", "activation", "retired", "extensions", "truncated", "diagnostics"]) {
      if ((data as Record<string, unknown>)[key] === undefined) invalid(`data.${key} is missing`);
    }
    return;
  }
  const error = envelope.error;
  if (!error || typeof error !== "object") invalid("error must be an object");
  const errorKeys = Object.keys(error!).sort();
  const expectedError = ["code", "details", "message", "retryable"];
  if (errorKeys.length !== expectedError.length || errorKeys.some((key, index) => key !== expectedError[index])) invalid("error fields differ from v1");
  if (!(FLEET_ERROR_CODES as readonly string[]).includes(error!.code)) invalid("error code is invalid");
  if (typeof error!.message !== "string" || error!.message.length === 0 || error!.message.length > MAX_STRING) invalid("error message is invalid");
  if (typeof error!.retryable !== "boolean") invalid("error retryable is invalid");
  const details = error!.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) invalid("error details must be an object");
  const entries = Object.entries(details);
  if (entries.length > MAX_DETAILS) invalid("error details are too large");
  for (const [key, value] of entries) {
    if (!key || !(["string", "number", "boolean"].includes(typeof value) || value === null)) invalid("error details are invalid");
  }
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

function section(lines: string[], title: string): void {
  lines.push("");
  lines.push(`  ${bold(cyan(glyph.chevron))} ${bold(title)}`);
}

/** Report in the `formatAuditReport` house style. The caller does the printing. */
export function formatFleetContractReport(inspection: FleetContractInspection): string {
  const ok = inspection.diagnostics.length === 0;
  const lines = [""];

  const headline = ok
    ? `${green(glyph.pass)} ${bold("Fleet contract valid")}`
    : `${red(glyph.fail)} ${bold("Fleet contract invalid")}`;
  const tally = ok
    ? [green(`${inspection.authorities.length} authorities`), green(`${inspection.classifications.length} lifecycle classes`)]
    : [red(`${inspection.diagnostics.length} finding${inspection.diagnostics.length === 1 ? "" : "s"}`)];
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot(tally)}`);

  const facts = [dim(inspection.contract_path)];
  if (inspection.contract_version) facts.push(dim(`contract ${inspection.contract_version}`));
  if (inspection.schema_version !== null) facts.push(dim(`schema ${inspection.schema_version}`));
  if (inspection.compatibility) {
    facts.push(dim(`compatible ${inspection.compatibility.min_schema_version}..${inspection.compatibility.max_schema_version}`));
  }
  facts.push(dim(`supported ${inspection.supported_schema_versions.min}..${inspection.supported_schema_versions.max}`));
  if (ok) facts.push(inspection.byte_stable ? dim("byte-stable round trip") : yellow("round trip NOT byte-stable"));
  lines.push(`  ${joinDot(facts)}`);

  if (inspection.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the file on disk is complete")}`);
    for (const note of inspection.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  if (!ok) {
    section(lines, "Findings");
    const width = inspection.diagnostics.reduce((max, item) => Math.max(max, item.code.length), 0);
    for (const diagnostic of inspection.diagnostics) {
      lines.push(`    ${red(glyph.fail)}  ${red(diagnostic.code.padEnd(width))}  ${diagnostic.path}`);
      lines.push(`       ${dim(glyph.arrow)} ${dim(diagnostic.message)}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  section(lines, "Authority owners");
  const authorityWidth = inspection.authorities.reduce((max, item) => Math.max(max, item.id.length), 0);
  const ownerWidth = inspection.authorities.reduce((max, item) => Math.max(max, item.owner.length), 0);
  for (const authority of inspection.authorities) {
    const style = statusStyle(authority.read_only ? "skip" : "pass");
    const count = authority.read_only ? "read-only" : `${authority.writable_fields.length} writable field${authority.writable_fields.length === 1 ? "" : "s"}`;
    lines.push(`    ${style.color(style.glyph)}  ${authority.id.padEnd(authorityWidth)}  ${cyan(authority.owner.padEnd(ownerWidth))}  ${dim(count)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${authority.store} via ${authority.store_env.join(", ")}`)}`);
  }

  section(lines, "Projections");
  const projectionWidth = inspection.projections.reduce((max, item) => Math.max(max, item.field.length), 0);
  for (const projection of inspection.projections) {
    lines.push(`    ${green(glyph.pass)}  ${projection.field.padEnd(projectionWidth)}  ${cyan(projection.writable_by)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${projection.source} -> ${projection.target}`)}`);
  }

  section(lines, "Lifecycle classes");
  const classWidth = inspection.classifications.reduce((max, item) => Math.max(max, item.id.length), 0);
  for (const classification of inspection.classifications) {
    lines.push(`    ${green(glyph.pass)}  ${classification.id.padEnd(classWidth)}  ${dim(`${classification.entry_count} declared entr${classification.entry_count === 1 ? "y" : "ies"}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`requires ${classification.required_fields.join(", ")}`)}`);
  }

  section(lines, "Canonical service model");
  for (const line of describeTree(inspection.service_model)) lines.push(`    ${dim(glyph.bullet)} ${line}`);

  section(lines, "Activation");
  for (const line of describeTree(inspection.activation)) lines.push(`    ${dim(glyph.bullet)} ${line}`);

  section(lines, "Superseded modes");
  const retiredWidth = inspection.retired.reduce((max, item) => Math.max(max, item.id.length), 0);
  for (const mode of inspection.retired) {
    lines.push(`    ${gray(glyph.skip)}  ${gray(mode.id.padEnd(retiredWidth))}  ${dim(mode.reason)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`superseded by ${mode.superseded_by}`)}`);
  }

  section(lines, "Extensions (recorded, never policy)");
  if (inspection.extensions.length === 0) lines.push(`    ${dim("none")}`);
  else for (const extension of inspection.extensions) lines.push(`    ${dim(glyph.dot)} ${yellow(extension.path)}`);

  lines.push("");
  return lines.join("\n");
}

/** Flatten a bounded open-keyed subtree into `a.b.c  value` report lines. */
function describeTree(node: unknown, prefix = ""): string[] {
  if (node === null || node === undefined) return [dim("not declared")];
  const flat: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item !== "object" || item === null)) {
        flat.push([path, value.map((item) => String(item)).join(" -> ")]);
        return;
      }
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, path ? `${path}.${key}` : key);
      return;
    }
    flat.push([path, String(value)]);
  };
  walk(node, prefix);
  const width = flat.reduce((max, [path]) => Math.max(max, path.length), 0);
  return flat.map(([path, value]) => `${padVisible(path, width)}  ${cyan(value)}`);
}
