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
  type FleetConflictGroup,
  type FleetDiagnostic,
  type FleetErrorCode,
  type FleetExtension,
  type FleetFieldValue,
  type FleetInventory,
  type FleetInventoryFinding,
  type FleetInventoryRow,
  type FleetProbeRecord,
  type FleetProvenance,
  type FleetProvenanceFact,
  type FleetProvenanceStatus,
} from "./types";
import { bold, cyan, dim, glyph, gray, green, joinDot, padVisible, red, statusStyle, yellow } from "../utils/style";

/** Commands allowed to produce a fleet envelope. */
export const FLEET_COMMANDS = ["fleet.contract.validate", "fleet.inventory", "fleet.provenance"] as const;

/**
 * The `data` keys each command's success envelope must carry.
 *
 * Per-command, not one hardcoded list. While `validate` was the only command,
 * `validateFleetEnvelope` asserted its ten keys on EVERY `ok` envelope -- so the
 * second command in the namespace could not emit a success envelope at all; it
 * threw INTERNAL_ERROR out of `renderFleetJson` instead.
 */
const FLEET_COMMAND_DATA_KEYS: Record<string, readonly string[]> = {
  "fleet.contract.validate": [
    "contract_path", "authorities", "projections", "classifications",
    "service_model", "activation", "retired", "extensions", "truncated", "diagnostics",
  ],
  // `scope`, `contract_path` and `contract_version` are emitted, rendered by the
  // human report, and asserted by the suite; leaving them off this list meant
  // the validator would have waved through an envelope that dropped them.
  "fleet.inventory": [
    "contract_path", "contract_version", "scope",
    "stores", "totals", "health", "rows", "conflicts", "findings", "truncated",
  ],
  // Same discipline the inventory entry documents: a key omitted here is a key
  // `validateFleetEnvelope` will wave through if a future edit drops it, so
  // every key the report renders and the suite asserts is listed.
  "fleet.provenance": [
    "contract_path", "contract_version", "scope",
    "sources", "totals", "health", "facts", "probes", "findings", "truncated",
  ],
};

const MAX_STRING = 512;
const MAX_DETAILS = 20;
const MAX_NEXT_ACTIONS = 20;
/** Notes carried in a view before the envelope's list cap applies. */
const MAX_NOTES = 10;

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

/**
 * Strip control characters and cap length. Same rule as the notebook envelope,
 * plus one this surface needs: CR and LF fold to a space rather than survive.
 * Every bounded string here is printed as one row of a report, so a newline
 * inside a contract value let that value forge additional rows.
 */
export function bounded(value: string, max = MAX_STRING): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, max);
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
  // Kept in step with HOST_PATH in contract.ts: `/root` is a home directory
  // too, and leaving it out meant `--contract /root/x.yaml` echoed the path
  // back verbatim while `/home/someone/x.yaml` was redacted.
  return path
    .replace(/^\/(home|Users)\/[^/]+/u, "/$1/<redacted>")
    .replace(/^\/root(?=\/|$)/u, "/root/<redacted>");
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

/**
 * Bound a declared string list and record the clip.
 *
 * `writable_fields`, `store_env` and `detect` were once copied with a bare
 * spread, so a contract with thousands of entries produced an envelope past
 * every documented bound while `truncated` stayed empty -- the one list whose
 * whole job is to say "you did not get all of it" was the one that could not
 * say so.
 *
 * Lives here rather than in `cli.ts` because the inventory needs the same bound
 * on the same terms, and two copies of a bound are two bounds.
 */
export function cappedStrings(values: readonly string[] | undefined, context: BoundedContext, path: string, max = MAX_ITEMS, noun = "items"): string[] {
  const all = values ?? [];
  if (all.length > max) context.truncated.push(`${path}: ${all.length - max} of ${all.length} ${noun} dropped`);
  return all.slice(0, max).map((value) => bounded(value));
}

export function boundedNotes(notes: readonly string[] | undefined, context: BoundedContext, path: string): string[] {
  // `noun` is not decoration: folding this into `cappedStrings` silently
  // rewrote a shipped truncation note from "N of M notes dropped" to
  // "... items dropped", and no check reads that clip.
  return cappedStrings(notes, context, path, MAX_NOTES, "notes");
}

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
  // One slot held back for the marker below, so the clip can always announce
  // itself. Without it a 30-finding contract produced 18 entries and a count of
  // 30, and the only way to notice was to compare the two by hand -- the same
  // "quietly short-changed" failure `truncated` exists to prevent on the
  // success path.
  const room = MAX_DETAILS - Object.keys(details).length - 1;
  const shown = Math.max(0, Math.min(room, diagnostics.length));
  diagnostics.slice(0, shown).forEach((diagnostic, index) => {
    details[`${index}:${diagnostic.path}`] = `${diagnostic.code}: ${diagnostic.message}`;
  });
  if (shown < diagnostics.length) {
    details.diagnostics_truncated = `showing ${shown} of ${diagnostics.length} findings; run without --json for the full report`;
  }
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
    const required = FLEET_COMMAND_DATA_KEYS[envelope.command];
    if (!required) invalid("command declares no required data keys");
    for (const key of required!) {
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
    // A read-only authority (the process table) resolves from no env key at
    // all; `via` with nothing after it read as a truncated line.
    const resolvedBy = authority.store_env.length ? ` via ${bounded(authority.store_env.join(", "))}` : "";
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${bounded(authority.store)}${resolvedBy}`)}`);
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

// ---------------------------------------------------------------------------
// Inventory report
// ---------------------------------------------------------------------------

/** How many rows the human report prints before it says how many it withheld. */
const REPORT_MAX_ROWS = 60;
/** How many findings the human report lists in the "top findings" block. */
const REPORT_MAX_FINDINGS = 25;

function fieldCell(value: FleetFieldValue<unknown>): string {
  const shown = value.value === null
    ? "-"
    : Array.isArray(value.value)
      ? value.value.map((item) => String(item)).join(", ")
      : typeof value.value === "object"
        ? Object.entries(value.value as Record<string, unknown>).filter(([, item]) => item !== null).map(([key, item]) => `${key}=${String(item)}`).join(" ")
        : String(value.value);
  return bounded(shown || "-");
}

function stateColor(state: string): (value: string | number) => string {
  if (state === "resolved") return green;
  if (state === "conflicted") return red;
  if (state === "unobserved") return gray;
  return yellow;
}

function findingGlyph(severity: FleetInventoryFinding["severity"]): string {
  if (severity === "error") return red(glyph.fail);
  if (severity === "warn") return yellow(glyph.warn);
  return dim(glyph.info);
}

function conflictLine(group: FleetConflictGroup): string {
  const verdict = group.permitted
    ? gray(`permitted${group.exception_id ? ` by ${bounded(group.exception_id)}` : ""}`)
    : red("unpermitted");
  return `    ${group.permitted ? gray(glyph.skip) : red(glyph.fail)}  ${bold(bounded(group.value))}  ${dim(glyph.dot)}  ${verdict}`;
}

function rowLines(row: FleetInventoryRow, idWidth: number): string[] {
  const id = row.agent_id.value ?? "<unnamed>";
  const state = row.conflicts.length ? "conflicted" : row.malformed ? "unresolved" : row.project_id.state;
  const style = stateColor(state);
  const head = `    ${style(state === "resolved" ? glyph.pass : state === "conflicted" ? glyph.fail : glyph.warn)}  `
    + `${padVisible(bounded(id), idWidth)}  ${cyan(fieldCell(row.role))}  ${dim(fieldCell(row.project_id))}`;
  const detail = joinDot([
    dim(`profile ${fieldCell(row.profile_name)} (${row.profile_path.state})`),
    dim(`role_dir ${row.paths.role_dir?.classification ?? "undeclared"}`),
    dim(`bloodbank ${fieldCell(row.bloodbank_scope)}/${row.activation.value === true ? "activated" : "deny"}`),
  ]);
  const lines = [head, `       ${dim(glyph.arrow)} ${detail}`];
  if (row.conflicts.length) lines.push(`       ${dim(glyph.arrow)} ${red(`conflicts: ${row.conflicts.join(", ")}`)}`);
  if (row.findings.length) lines.push(`       ${dim(glyph.arrow)} ${dim(`findings: ${bounded(row.findings.join(", "))}`)}`);
  return lines;
}

/**
 * Report in the `formatFleetContractReport` house style. The caller prints it.
 *
 * The health verdict leads deliberately. An unhealthy fleet exits 0 -- conflicts
 * are data, not a command failure -- so a report that opened with a row dump
 * would let "the command worked" read as "the fleet is fine".
 */
export function formatFleetInventoryReport(inventory: FleetInventory): string {
  const { health, totals } = inventory;
  const lines = [""];

  const headline = health.healthy
    ? `${green(glyph.pass)} ${bold("Fleet inventory healthy")}`
    : `${red(glyph.fail)} ${bold("Fleet inventory UNHEALTHY")}`;
  const tally = [
    `${totals.observed} of ${totals.source_rows} rows`,
    health.conflicts ? red(`${health.conflicts} unpermitted conflict${health.conflicts === 1 ? "" : "s"}`) : green("0 unpermitted conflicts"),
    health.malformed_rows ? red(`${health.malformed_rows} malformed`) : dim("0 malformed"),
  ];
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot(tally)}`);
  // The verdict's own reasons, on the line under it. They were computed, shipped
  // in JSON, and never rendered -- so the operator who cannot run `--json` could
  // see THAT the fleet was unhealthy and never why.
  const why = [
    health.unresolved_rows ? yellow(`${health.unresolved_rows} unresolved`) : dim("0 unresolved"),
    health.contract_violations ? red(`${health.contract_violations} contract violation${health.contract_violations === 1 ? "" : "s"}`) : dim("0 contract violations"),
    health.permitted_conflicts ? dim(`${health.permitted_conflicts} permitted`) : dim("0 permitted"),
    health.collection_errors ? red(`${health.collection_errors} unreadable store${health.collection_errors === 1 ? "" : "s"}`) : dim("0 unreadable stores"),
  ];
  lines.push(`  ${dim(glyph.arrow)} ${joinDot(why)}`);
  lines.push(`  ${joinDot([dim(inventory.scope.label), dim(inventory.contract_path), dim(`contract ${inventory.contract_version ?? "?"}`)])}`);

  section(lines, "Stores");
  const storeWidth = inventory.stores.reduce((max, store) => Math.max(max, store.id.length), 0);
  for (const store of inventory.stores) {
    const style = statusStyle(store.exists && store.parse === "ok" ? "pass" : store.exists ? "warn" : "fail");
    lines.push(`    ${style.color(style.glyph)}  ${padVisible(store.id, storeWidth)}  ${cyan(store.owner ?? "unowned")}  ${dim(`${store.source_rows} record${store.source_rows === 1 ? "" : "s"} · ${store.parse}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`configured ${store.configured_path}`)}`);
    if (store.overridden) lines.push(`       ${dim(glyph.arrow)} ${yellow(`inspected ${store.inspected_path}`)}`);
  }

  section(lines, "Totals");
  for (const [label, value] of Object.entries(totals)) {
    lines.push(`    ${dim(glyph.bullet)} ${padVisible(label, 24)}  ${cyan(String(value))}`);
  }
  if (totals.source_rows !== totals.emitted_rows) {
    lines.push(`    ${red(glyph.fail)} source_rows and emitted_rows disagree; a row was lost between counting and building`);
  }

  section(lines, "Conflict groups");
  if (inventory.conflicts.length === 0) lines.push(`    ${dim("none")}`);
  for (const group of inventory.conflicts) {
    lines.push(conflictLine(group));
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${group.field} · owned by ${group.owners.join(", ") || "nobody declared"} · ${group.participants.join(", ")}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(group.id)}`);
  }

  section(lines, "Agents");
  const idWidth = inventory.rows.reduce((max, row) => Math.max(max, (row.agent_id.value ?? "").length), 0);
  for (const row of inventory.rows.slice(0, REPORT_MAX_ROWS)) for (const line of rowLines(row, idWidth)) lines.push(line);
  if (inventory.rows.length > REPORT_MAX_ROWS) {
    lines.push(`    ${dim(`... ${inventory.rows.length - REPORT_MAX_ROWS} more row(s); use --json for all of them`)}`);
  }

  section(lines, "Findings");
  if (inventory.findings.length === 0) lines.push(`    ${dim("none")}`);
  const codeWidth = inventory.findings.slice(0, REPORT_MAX_FINDINGS).reduce((max, item) => Math.max(max, item.code.length), 0);
  for (const finding of inventory.findings.slice(0, REPORT_MAX_FINDINGS)) {
    lines.push(`    ${findingGlyph(finding.severity)}  ${padVisible(finding.code, codeWidth)}  ${dim(finding.field)}${finding.agent_id ? `  ${cyan(finding.agent_id)}` : ""}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${finding.detail} · owner ${finding.source ?? "undeclared"}`)}`);
  }
  if (inventory.findings.length > REPORT_MAX_FINDINGS) {
    lines.push(`    ${dim(`... ${inventory.findings.length - REPORT_MAX_FINDINGS} more finding(s); use --json for all of them`)}`);
  }

  if (inventory.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the stores on disk are complete")}`);
    for (const note of inventory.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provenance report
// ---------------------------------------------------------------------------

/** How many facts the human report prints before it says how many it withheld. */
const REPORT_MAX_FACTS = 80;
/** How many probe records the human report lists. */
const REPORT_MAX_PROBES = 30;

function provenanceGlyph(status: FleetProvenanceStatus): string {
  if (status === "match") return green(glyph.pass);
  if (status === "mismatch") return red(glyph.fail);
  if (status === "dirty" || status === "missing") return yellow(glyph.warn);
  return gray(glyph.skip);
}

function provenanceColor(status: FleetProvenanceStatus): (value: string | number) => string {
  if (status === "match") return green;
  if (status === "mismatch") return red;
  if (status === "dirty" || status === "missing") return yellow;
  return gray;
}

function sideCell(side: { value: string | null; family: string | null }): string {
  const shown = side.value ?? "-";
  return bounded(side.family && side.family !== "pinned-release" ? `${shown} [${side.family}]` : shown);
}

function factLines(fact: FleetProvenanceFact, idWidth: number): string[] {
  const style = provenanceColor(fact.status);
  const subject = fact.agent_id ? `${fact.agent_id} ${glyph.dot} ${fact.id}` : fact.id;
  const lines = [
    `    ${provenanceGlyph(fact.status)}  ${padVisible(bounded(subject), idWidth)}  ${style(fact.status)}`,
    `       ${dim(glyph.arrow)} ${dim(`desired ${sideCell(fact.desired)} (${fact.desired.source ?? "no source"}/${fact.desired.state})`)}`,
    `       ${dim(glyph.arrow)} ${dim(`observed ${sideCell(fact.observed)} (${fact.observed.source ?? "no source"}/${fact.observed.state})`)}`,
  ];
  // The reason a fact is anything other than a match is the half an operator
  // acts on. A match needs no explanation and printing one for all 300 would
  // bury the ones that do.
  if (fact.status !== "match") lines.push(`       ${dim(glyph.arrow)} ${dim(fact.detail)}`);
  return lines;
}

function probeLine(record: FleetProbeRecord, kindWidth: number): string {
  const ok = record.outcome === "ok";
  const style = statusStyle(ok ? "pass" : record.outcome === "skipped" ? "skip" : "fail");
  const reason = record.reason ? `  ${dim(record.reason)}` : "";
  return `    ${style.color(style.glyph)}  ${padVisible(record.kind, kindWidth)}  ${dim(record.target)}  ${style.color(record.outcome)}${reason}`;
}

/**
 * Report in the `formatFleetInventoryReport` house style. The caller prints it.
 *
 * The verdict leads, and its REASONS lead with it. A drifted fleet exits 0 --
 * provenance drift is data, not a command failure -- so an operator on the human
 * path has to be able to see WHY provenance is unhealthy, not only that it is.
 * The two verdicts are deliberately separate: `healthy` is about drift,
 * `complete` is about whether everything that should have been observed was, and
 * a run that could not reach half the fleet must never read as a clean bill.
 */
export function formatFleetProvenanceReport(provenance: FleetProvenance): string {
  const { health, totals } = provenance;
  const lines = [""];

  const headline = health.healthy
    ? `${green(glyph.pass)} ${bold("Fleet provenance healthy")}`
    : `${red(glyph.fail)} ${bold("Fleet provenance UNHEALTHY")}`;
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot([
    `${totals.emitted_facts} of ${totals.facts} facts`,
    `${totals.agents} agent${totals.agents === 1 ? "" : "s"}`,
    health.complete ? green("complete") : yellow("INCOMPLETE"),
  ])}`);
  const why = [
    health.mismatched ? red(`${health.mismatched} mismatched`) : dim("0 mismatched"),
    health.dirty ? red(`${health.dirty} dirty`) : dim("0 dirty"),
    health.missing ? yellow(`${health.missing} missing`) : dim("0 missing"),
    health.unsupported ? gray(`${health.unsupported} unsupported`) : dim("0 unsupported"),
    health.unobserved ? yellow(`${health.unobserved} unobserved`) : dim("0 unobserved"),
    health.probe_failures ? red(`${health.probe_failures} probe failure${health.probe_failures === 1 ? "" : "s"}`) : dim("0 probe failures"),
  ];
  lines.push(`  ${dim(glyph.arrow)} ${joinDot(why)}`);
  lines.push(`  ${joinDot([dim(provenance.scope.label), dim(provenance.contract_path), dim(`contract ${provenance.contract_version ?? "?"}`)])}`);

  section(lines, "Sources");
  const sourceWidth = provenance.sources.reduce((max, source) => Math.max(max, source.id.length), 0);
  for (const source of provenance.sources) {
    const style = statusStyle(source.exists && source.parse === "ok" ? "pass" : "fail");
    lines.push(`    ${style.color(style.glyph)}  ${padVisible(source.id, sourceWidth)}  ${cyan(source.kind)}  ${dim(source.configured_path)}`);
    if (source.inspected_path !== source.configured_path) {
      lines.push(`       ${dim(glyph.arrow)} ${yellow(`inspected ${source.inspected_path}`)}`);
    }
  }

  section(lines, "Totals");
  for (const [label, value] of Object.entries(totals)) {
    if (label === "by_status") continue;
    lines.push(`    ${dim(glyph.bullet)} ${padVisible(label, 24)}  ${cyan(String(value))}`);
  }
  for (const [status, count] of Object.entries(totals.by_status)) {
    lines.push(`    ${dim(glyph.bullet)} ${padVisible(`by_status.${status}`, 24)}  ${provenanceColor(status as FleetProvenanceStatus)(String(count))}`);
  }

  section(lines, "Probes");
  if (provenance.probes.length === 0) lines.push(`    ${dim("none")}`);
  const kindWidth = provenance.probes.reduce((max, record) => Math.max(max, record.kind.length), 0);
  for (const record of provenance.probes.slice(0, REPORT_MAX_PROBES)) lines.push(probeLine(record, kindWidth));
  if (provenance.probes.length > REPORT_MAX_PROBES) {
    lines.push(`    ${dim(`... ${provenance.probes.length - REPORT_MAX_PROBES} more probe(s); use --json for all of them`)}`);
  }

  section(lines, "Facts");
  // Drift first, then everything else. An operator scanning 300 facts for the
  // handful that need a decision should not have to scroll past 200 matches.
  const ranked = [...provenance.facts].sort((a, b) => {
    const rank = (status: FleetProvenanceStatus): number => (status === "match" ? 1 : 0);
    return rank(a.status) - rank(b.status);
  });
  const factWidth = ranked.slice(0, REPORT_MAX_FACTS)
    .reduce((max, fact) => Math.max(max, (fact.agent_id ? `${fact.agent_id} ${glyph.dot} ${fact.id}` : fact.id).length), 0);
  for (const fact of ranked.slice(0, REPORT_MAX_FACTS)) for (const line of factLines(fact, factWidth)) lines.push(line);
  if (ranked.length > REPORT_MAX_FACTS) {
    lines.push(`    ${dim(`... ${ranked.length - REPORT_MAX_FACTS} more fact(s); use --json for all of them`)}`);
  }

  section(lines, "Findings");
  if (provenance.findings.length === 0) lines.push(`    ${dim("none")}`);
  const codeWidth = provenance.findings.slice(0, REPORT_MAX_FINDINGS).reduce((max, item) => Math.max(max, item.code.length), 0);
  for (const finding of provenance.findings.slice(0, REPORT_MAX_FINDINGS)) {
    lines.push(`    ${findingGlyph(finding.severity)}  ${padVisible(finding.code, codeWidth)}  ${dim(finding.field)}${finding.agent_id ? `  ${cyan(finding.agent_id)}` : ""}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${finding.detail} ${glyph.dot} owner ${finding.source ?? "undeclared"}`)}`);
  }
  if (provenance.findings.length > REPORT_MAX_FINDINGS) {
    lines.push(`    ${dim(`... ${provenance.findings.length - REPORT_MAX_FINDINGS} more finding(s); use --json for all of them`)}`);
  }

  if (provenance.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the sources on disk are complete")}`);
    for (const note of provenance.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * A command failure, in the same house style as the success reports.
 *
 * The human path still owes the operator a readable answer when the command
 * itself failed: an unreadable registry, an unknown agent, a rejected flag. The
 * error's message and code are already bounded and home-redacted by the time
 * they reach here.
 */
export function formatFleetErrorReport(title: string, error: { code: string; message: string; details?: Record<string, unknown> | null }): string {
  const lines = [
    "",
    `  ${red(glyph.fail)} ${bold(title)}  ${dim(glyph.dot)}  ${red(error.code)}`,
    `     ${dim(glyph.arrow)} ${dim(bounded(error.message))}`,
  ];
  // The detail is the half that identifies the failure: WHICH path was not
  // there, WHICH agent id is not registered. It goes through the same
  // `sanitizeDetails` the JSON path uses, so the human report cannot become the
  // looser of the two surfaces; the operator most likely to have fat-fingered a
  // path was the one who could not see it.
  for (const [key, value] of Object.entries(sanitizeDetails(error.details ?? {}))) {
    if (value === null) continue;
    lines.push(`     ${dim(glyph.arrow)} ${dim(`${key} ${bounded(String(value))}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}
