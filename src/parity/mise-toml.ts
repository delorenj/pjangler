/**
 * PJAN-135: structural, parse-verified editing of mise.toml.
 *
 * The hook rewrite used to scrape mise.toml line by line with regexes. That
 * read comment text as hook commands (a quoted `rm -f` inside a `# ...` comment
 * became a command that ran on leave), treated a `[` line inside a multi-line
 * string as a table header, split one inline-table hook into two spawned
 * commands, dropped `[hooks] postinstall` and orphaned `cd` into `[tools]`,
 * left an empty `[[hooks.cd]]` mise refuses to load, and claimed an operator's
 * command joined into the same hook as a retired writer. Every one of those was
 * written to disk and reported `applied`, and each re-audit passed.
 *
 * This module replaces the scrape with three pieces that check each other:
 *
 * 1. `scanToml` finds statement boundaries (headers, key/values, comments) with
 *    a string-aware lexer. It never interprets values; `smol-toml` does.
 * 2. `decideHookDefs` decides, from PARSED hook values only, which commands an
 *    owner claims and what the hooks must mean afterwards. It works per
 *    command: a legacy `scripts` array is judged element by element, before any
 *    join, and a compound command is never claimed whole.
 * 3. `verifyMiseRewrite` / `checkRewrite` parse the rewritten text and compare
 *    its meaning with the original: every hook (kind, order, command, shell),
 *    every task, tools, env and everything else. Only the owner's intended
 *    changes may differ. A rewrite that fails the check is not written.
 *
 * mise's meaning of each hook form, measured on mise 2026.9.12 with isolated
 * MISE_* directories:
 *   `[hooks] K = "cmd"`             one spawned `sh -o errexit -c cmd`
 *   `[hooks] K = ["a", "b"]`        two separate spawned hooks (a failing `a` does not stop `b`)
 *   `[hooks] K = [{...}, "b"]`      each element is one hook
 *   `[[hooks.K]] run = "cmd"`       one spawned hook
 *   `[[hooks.K]] script = "cmd"`    the same, deprecated spelling (warns; removed in 2027.3.0)
 *   `[[hooks.K]] scripts = [a, b]`  ONE spawned hook `a\nb` (a failing `a` stops `b`)
 *   `shell = "bash"` + `script`     sourced into the operator's shell, not spawned
 *   `[hooks.K]` single table        the same as one `[[hooks.K]]` element
 *   `task = "name"`                 runs that task
 *   any other key (`dir`, ...)      mise refuses the whole config
 * So a `[hooks]` array element becomes its own `[[hooks.K]]` table, a `scripts`
 * array becomes one newline-joined `run`, and a `shell` table is never renamed.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type TomlTable = Record<string, unknown>;

export const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface TomlStatement {
  type: "header" | "kv" | "trivia";
  /** First line (0-based). */
  start: number;
  /** Exclusive end line. */
  end: number;
  /** header: the table path; kv: the key path relative to its table. */
  path: string[];
  arrayTable: boolean;
  /** Index of the header statement this one belongs to; -1 for the root table. */
  table: number;
  /** kv: the raw value text, inner comments included, trailing comment excluded. */
  valueText: string;
  /** Every comment inside the statement, inner ones first, then the trailing one. */
  comments: string[];
}

export class TomlScanError extends Error {}

/**
 * Split TOML text into statements. Strings (all four kinds), arrays, inline
 * tables and comments are lexed, so a `[`, `#` or `"` inside a string or a
 * comment never moves a boundary. Values are not interpreted.
 */
export function scanToml(text: string): TomlStatement[] {
  const statements: TomlStatement[] = [];
  const n = text.length;
  let i = 0;
  let line = 0;
  let table = -1;
  const fail = (message: string): never => { throw new TomlScanError(`line ${line + 1}: ${message}`); };
  const skipBlank = () => { while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++; };
  const readComment = (): string => {
    const from = i;
    while (i < n && text[i] !== "\n") i++;
    return text.slice(from, i).replace(/\r$/, "");
  };
  const finish = (): number => {
    if (i >= n) return line + 1;
    if (text[i] !== "\n") fail(`unexpected ${JSON.stringify(text[i])}`);
    i++;
    line++;
    return line;
  };
  const basicString = () => {
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") i++;
      if (text[i] === "\n") fail("newline inside a string");
      i++;
    }
    if (i >= n) fail("unterminated string");
    i++;
  };
  const literalString = () => {
    i++;
    while (i < n && text[i] !== "'") {
      if (text[i] === "\n") fail("newline inside a string");
      i++;
    }
    if (i >= n) fail("unterminated string");
    i++;
  };
  const multiline = (quote: '"' | "'") => {
    const delimiter = quote.repeat(3);
    i += 3;
    for (;;) {
      if (i >= n) fail("unterminated multi-line string");
      if (quote === '"' && text[i] === "\\") {
        i++;
        if (text[i] === "\n") line++;
        i++;
        continue;
      }
      if (text.startsWith(delimiter, i)) {
        i += 3;
        // Up to two quotes may directly precede the closing delimiter.
        for (let extra = 0; extra < 2 && text[i] === quote; extra++) i++;
        return;
      }
      if (text[i] === "\n") line++;
      i++;
    }
  };
  const decodeBasic = (raw: string): string => {
    try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
  };
  const readKey = (): string[] => {
    const path: string[] = [];
    for (;;) {
      skipBlank();
      const from = i;
      if (text[i] === '"') {
        basicString();
        path.push(decodeBasic(text.slice(from + 1, i - 1)));
      } else if (text[i] === "'") {
        literalString();
        path.push(text.slice(from + 1, i - 1));
      } else {
        while (i < n && /[A-Za-z0-9_-]/.test(text[i]!)) i++;
        if (i === from) fail("expected a key");
        path.push(text.slice(from, i));
      }
      skipBlank();
      if (text[i] === ".") {
        i++;
        continue;
      }
      return path;
    }
  };
  const readValue = (): { valueText: string; comments: string[] } => {
    const from = i;
    let last = i;
    let depth = 0;
    const comments: string[] = [];
    while (i < n) {
      const ch = text[i]!;
      if (ch === '"') {
        if (text.startsWith('"""', i)) multiline('"');
        else basicString();
        last = i;
        continue;
      }
      if (ch === "'") {
        if (text.startsWith("'''", i)) multiline("'");
        else literalString();
        last = i;
        continue;
      }
      if (ch === "#") {
        comments.push(readComment());
        continue;
      }
      if (ch === "\n") {
        if (depth <= 0) break;
        line++;
        i++;
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      i++;
      if (ch !== " " && ch !== "\t" && ch !== "\r") last = i;
    }
    if (depth > 0) fail("unterminated array or inline table");
    return { valueText: text.slice(from, last), comments };
  };

  while (i < n) {
    const start = line;
    skipBlank();
    if (i >= n) {
      statements.push({ type: "trivia", start, end: start + 1, path: [], arrayTable: false, table, valueText: "", comments: [] });
      break;
    }
    const ch = text[i]!;
    if (ch === "\n") {
      i++;
      line++;
      statements.push({ type: "trivia", start, end: line, path: [], arrayTable: false, table, valueText: "", comments: [] });
      continue;
    }
    if (ch === "#") {
      const comment = readComment();
      const end = finish();
      statements.push({ type: "trivia", start, end, path: [], arrayTable: false, table, valueText: "", comments: [comment] });
      continue;
    }
    if (ch === "[") {
      i++;
      const arrayTable = text[i] === "[";
      if (arrayTable) i++;
      const path = readKey();
      if (text[i] !== "]") fail("expected ] after a table name");
      i++;
      if (arrayTable) {
        if (text[i] !== "]") fail("expected ]] after an array-of-tables name");
        i++;
      }
      skipBlank();
      const comments = text[i] === "#" ? [readComment()] : [];
      const end = finish();
      table = statements.length;
      statements.push({ type: "header", start, end, path, arrayTable, table: -1, valueText: "", comments });
      continue;
    }
    const path = readKey();
    if (text[i] !== "=") fail("expected = after a key");
    i++;
    skipBlank();
    const { valueText, comments } = readValue();
    if (!valueText) fail("missing value");
    const end = finish();
    statements.push({ type: "kv", start, end, path, arrayTable: false, table, valueText, comments });
  }
  return statements;
}

/** The kv statements of the table whose header is `statements[header]` (-1: root). */
export function tableBody(statements: readonly TomlStatement[], header: number): TomlStatement[] {
  return statements.filter((statement) => statement.type === "kv" && statement.table === header);
}

/** Lines [header.start, end-of-last-body-kv): a table without its trailing trivia. */
export function tableSpan(statements: readonly TomlStatement[], header: number): { start: number; end: number; body: TomlStatement[] } {
  const body = tableBody(statements, header);
  const head = statements[header]!;
  return { start: head.start, end: body.length ? body[body.length - 1]!.end : head.end, body };
}

export function parseValue(valueText: string): unknown {
  return (parseToml(`v = ${valueText}`) as TomlTable).v;
}

/** Parse a table's body as its own document. */
export function parseBody(lines: readonly string[], statements: readonly TomlStatement[], header: number): TomlTable {
  const { body } = tableSpan(statements, header);
  if (!body.length) return {};
  return parseToml(lines.slice(body[0]!.start, body[body.length - 1]!.end).join("\n")) as TomlTable;
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

export interface LineEdit {
  /** First original line replaced (or the insertion point). */
  start: number;
  /** Exclusive end; equal to start for a pure insertion. */
  end: number;
  lines: string[];
}

/**
 * Apply non-overlapping line edits. Blank lines that a deletion leaves side by
 * side are collapsed to one; the operator's own blank runs are kept. Edits sit
 * on statement boundaries, so every collapsed line is a blank trivia line and
 * never part of a multi-line string.
 */
export function applyLineEdits(text: string, edits: readonly LineEdit[]): string {
  if (!edits.length) return text;
  const lines = text.split("\n");
  // Same start: a pure insertion goes before a replacement; otherwise creation order.
  const ordered = edits.map((edit, seq) => ({ ...edit, seq }))
    .sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.seq - b.seq);
  for (let k = 1; k < ordered.length; k++) {
    if (ordered[k]!.start < ordered[k - 1]!.end) throw new TomlScanError(`overlapping edits at line ${ordered[k]!.start + 1}`);
  }
  // Rebuild front to back; `origin` is the original line index, null if generated.
  const out: Array<{ text: string; origin: number | null }> = [];
  let cursor = 0;
  for (const edit of ordered) {
    for (; cursor < edit.start; cursor++) out.push({ text: lines[cursor]!, origin: cursor });
    for (const inserted of edit.lines) out.push({ text: inserted, origin: null });
    cursor = Math.max(cursor, edit.end);
  }
  for (; cursor < lines.length; cursor++) out.push({ text: lines[cursor]!, origin: cursor });
  // A seam sits before out[k] when out[k] is generated, follows a generated
  // line, or does not directly follow its original predecessor.
  const seamBefore = (k: number): boolean => {
    if (k === 0) return out[0]!.origin !== 0;
    if (k >= out.length) return out[out.length - 1]!.origin !== lines.length - 1;
    const previous = out[k - 1]!.origin;
    const current = out[k]!.origin;
    return previous === null || current === null || current !== previous + 1;
  };
  const blank = (k: number) => out[k]!.text.trim() === "";
  const result: string[] = [];
  for (let k = 0; k < out.length; k++) {
    if (!blank(k)) {
      result.push(out[k]!.text);
      continue;
    }
    let j = k;
    while (j < out.length && blank(j)) j++;
    let seam = false;
    for (let m = k; m <= j; m++) seam ||= seamBefore(m);
    // The file's final "" (after its last newline) is a terminator, not a line.
    const terminal = j === out.length && out[out.length - 1]!.text === "";
    if (!seam) result.push(...out.slice(k, j).map((entry) => entry.text));
    else if (terminal) result.push("");
    else if (k > 0) result.push(out[k]!.text);
    k = j - 1;
  }
  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Hook model
// ---------------------------------------------------------------------------

/** The hook definitions of one kind, in mise order. */
export function hookDefs(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** One hook definition in its canonical meaning (see the table at the top). */
export function normalizeHookDef(def: unknown): unknown {
  if (typeof def === "string") return { run: def };
  if (!isTable(def)) return def;
  if (typeof def.shell === "string" || def.run !== undefined) return def;
  const { script, scripts, ...rest } = def;
  if (typeof script === "string" && scripts === undefined) return { run: script, ...rest };
  if (Array.isArray(scripts) && scripts.every((entry) => typeof entry === "string") && script === undefined) {
    return { run: scripts.join("\n"), ...rest };
  }
  return def;
}

/** Every hook kind with at least one definition, normalized. */
export function normalizedHooks(hooks: unknown): Record<string, unknown[]> {
  if (!isTable(hooks)) return {};
  const out: Record<string, unknown[]> = {};
  for (const [kind, value] of Object.entries(hooks)) {
    const defs = hookDefs(value).map(normalizeHookDef);
    if (defs.length) out[kind] = defs;
  }
  return out;
}

export interface HookCommands {
  /** The commands an owner may claim: one per `run`/`script`/string, one per `scripts` element. */
  commands: string[] | null;
  task?: string;
  shell: boolean;
  /** Which key holds the command in a table definition. */
  key?: "run" | "script" | "scripts";
}

export function hookCommands(def: unknown): HookCommands {
  if (typeof def === "string") return { commands: [def], shell: false };
  if (!isTable(def)) return { commands: null, shell: false };
  const shell = typeof def.shell === "string";
  if (typeof def.task === "string") return { commands: null, task: def.task, shell };
  if (shell) return typeof def.script === "string" ? { commands: [def.script], shell, key: "script" } : { commands: null, shell };
  if (typeof def.run === "string") return { commands: [def.run], shell, key: "run" };
  if (typeof def.script === "string") return { commands: [def.script], shell, key: "script" };
  if (Array.isArray(def.scripts) && def.scripts.every((entry) => typeof entry === "string")) {
    return { commands: def.scripts as string[], shell, key: "scripts" };
  }
  return { commands: null, shell };
}

export interface HookOwnerPolicy {
  /** Short name for messages. */
  name: string;
  /** Does this owner claim `command` in hooks.<kind>? Called per command. */
  owns(command: string, kind: string): boolean;
  /** Does this owner claim a `task = …` hook? */
  ownsTask?(task: string, kind: string): boolean;
  /** A command that mentions something this owner manages but that it will not split (compound). */
  mixed?(command: string, kind: string): string | undefined;
  /** A foreign command that already does the managed hook's job: adding the managed hook would run it twice. */
  blocksCanonical?(command: string, kind: string): boolean;
  /** The one managed enter-hook command, if this owner installs one. */
  canonical?: string;
  /** Rename `script`/`scripts` of kept spawned-command tables to `run`. */
  renameLegacy: boolean;
  /** Comment block written above a freshly created managed hook. */
  header?: string;
}

export type UnitDecision =
  | { action: "keep" }
  | { action: "drop" }
  | { action: "canonical" }
  | { action: "reduce"; kept: string[] };

export interface HookClaim {
  kind: string;
  /** The claimed command, or `mise run <task>` for a `task = …` hook. */
  command: string;
}

export interface HookManual {
  kind: string;
  command: string;
  reason: string;
}

export interface HookDecisions {
  perKind: Map<string, UnitDecision[]>;
  /** Index in hooks.enter before which the managed hook is inserted (when no owned unit is replaced by it). */
  insertCanonicalAt?: number;
  /** The normalized hooks the rewrite must produce. */
  expected: Record<string, unknown[]>;
  /** Every command the owner claims, per kind, in order. */
  claimed: HookClaim[];
  /** Commands the owner will not touch, and why: the operator's to fix. */
  manual: HookManual[];
  /** How many hooks.enter definitions already are exactly the managed command. */
  canonicalCount: number;
  /** True when the rewrite changes what the hooks mean. */
  changes: boolean;
}

export const shortCommand = (command: string) => {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
};

/**
 * Decide, from parsed hook values alone, what `policy` changes. A definition
 * is dropped only when EVERY command in it is owned; a `scripts` array with
 * some owned elements keeps the others; a compound command is never owned.
 */
export function decideHookDefs(hooks: unknown, policy: HookOwnerPolicy): HookDecisions {
  const perKind = new Map<string, UnitDecision[]>();
  const claimed: HookClaim[] = [];
  const manual: HookManual[] = [];
  const table = isTable(hooks) ? hooks : {};
  for (const [kind, value] of Object.entries(table)) {
    const decisions = hookDefs(value).map((def): UnitDecision => {
      const { commands, task } = hookCommands(def);
      if (task !== undefined) {
        if (!policy.ownsTask?.(task, kind)) return { action: "keep" };
        claimed.push({ kind, command: `mise run ${task}` });
        return { action: "drop" };
      }
      if (!commands) return { action: "keep" };
      const owned = commands.map((command) => policy.owns(command, kind));
      commands.forEach((command, index) => {
        if (owned[index]) {
          claimed.push({ kind, command });
          return;
        }
        const reason = policy.mixed?.(command, kind);
        if (reason) manual.push({ kind, command, reason });
      });
      if (!owned.some(Boolean)) return { action: "keep" };
      if (owned.every(Boolean)) return { action: "drop" };
      return { action: "reduce", kept: commands.filter((_, index) => !owned[index]) };
    });
    perKind.set(kind, decisions);
  }

  let insertCanonicalAt: number | undefined;
  const canonical = policy.canonical;
  if (canonical) {
    const enter = perKind.get("enter") ?? [];
    const blocked = hookDefs(table.enter).some((def, index) => enter[index]?.action === "keep"
      && (hookCommands(def).commands ?? []).some((command) => policy.blocksCanonical?.(command, "enter")));
    const first = enter.findIndex((decision) => decision.action !== "keep");
    if (!blocked) {
      if (first >= 0 && enter[first]!.action === "drop") enter[first] = { action: "canonical" };
      else if (first >= 0) insertCanonicalAt = first;
      else insertCanonicalAt = 0;
      if (!perKind.has("enter") && insertCanonicalAt === 0) perKind.set("enter", []);
    }
  }

  const expected: Record<string, unknown[]> = {};
  for (const [kind, decisions] of perKind) {
    const defs = hookDefs(table[kind]);
    const out: unknown[] = [];
    decisions.forEach((decision, index) => {
      if (kind === "enter" && insertCanonicalAt === index) out.push({ run: canonical });
      if (decision.action === "keep") out.push(normalizeHookDef(defs[index]));
      else if (decision.action === "canonical") out.push({ run: canonical });
      else if (decision.action === "reduce") out.push(normalizeHookDef({ ...(defs[index] as TomlTable), scripts: decision.kept }));
    });
    if (kind === "enter" && insertCanonicalAt !== undefined && insertCanonicalAt >= decisions.length) out.push({ run: canonical });
    if (out.length) expected[kind] = out;
  }
  const before = normalizedHooks(table);
  const canonicalCount = canonical ? (before.enter ?? []).filter((def) => isDeepStrictEqualLoose(def, { run: canonical })).length : 0;
  return { perKind, insertCanonicalAt, expected, claimed, manual, canonicalCount, changes: !isDeepStrictEqualLoose(before, expected) };
}

// ---------------------------------------------------------------------------
// Hook inventory: parsed hook definitions mapped onto their text
// ---------------------------------------------------------------------------

export interface HookUnit {
  kind: string;
  /** aot `[[hooks.K]]`, table `[hooks.K]`, key `[hooks] K = "…"|{…}`, elem `[hooks] K = [ … ]` element. */
  form: "aot" | "table" | "key" | "elem";
  value: unknown;
  /** aot/table: the header statement index; key/elem: the `[hooks]` key statement index. */
  statement: number;
  /** aot/table: lines of the header through the last body kv; key/elem: the key statement. */
  start: number;
  end: number;
}

export interface HookInventory {
  text: string;
  lines: string[];
  statements: TomlStatement[];
  parsed: TomlTable;
  byKind: Map<string, HookUnit[]>;
  /** Kinds (or "*") written in a form this module does not edit, and why. */
  unsupported: Map<string, string>;
  /** The `[hooks]` header statement index, if any. */
  hooksHeader: number;
}

export function hookInventory(text: string): HookInventory {
  const parsed = parseToml(text) as TomlTable;
  const statements = scanToml(text);
  const lines = text.split("\n");
  const byKind = new Map<string, HookUnit[]>();
  const unsupported = new Map<string, string>();
  const add = (unit: HookUnit) => {
    const list = byKind.get(unit.kind) ?? [];
    list.push(unit);
    byKind.set(unit.kind, list);
  };
  let hooksHeader = -1;
  statements.forEach((statement, index) => {
    if (statement.type === "header") {
      if (statement.path[0] !== "hooks") return;
      if (statement.path.length === 1) {
        if (statement.arrayTable) unsupported.set("*", "an array of `[[hooks]]` tables");
        else hooksHeader = index;
        return;
      }
      const kind = statement.path[1]!;
      if (statement.path.length > 2) {
        unsupported.set(kind, `the sub-table [${statement.path.join(".")}]`);
        return;
      }
      const span = tableSpan(statements, index);
      add({ kind, form: statement.arrayTable ? "aot" : "table", value: parseBody(lines, statements, index), statement: index, start: span.start, end: span.end });
      return;
    }
    if (statement.type !== "kv") return;
    const owner = statement.table >= 0 ? statements[statement.table]! : undefined;
    const fullPath = [...(owner?.path ?? []), ...statement.path];
    if (fullPath[0] !== "hooks") return;
    if (owner && owner.path.length >= 2) return; // a body line of [[hooks.K]] / [hooks.K]
    if (owner && owner.path.length === 1 && !owner.arrayTable && statement.path.length === 1) {
      const kind = statement.path[0]!;
      const value = parseValue(statement.valueText);
      if (typeof value === "string" || isTable(value)) {
        add({ kind, form: "key", value, statement: index, start: statement.start, end: statement.end });
      } else if (Array.isArray(value)) {
        for (const element of value) add({ kind, form: "elem", value: element, statement: index, start: statement.start, end: statement.end });
      } else {
        unsupported.set(kind, `a ${typeof value} value for [hooks] ${kind}`);
      }
      return;
    }
    unsupported.set(fullPath[1] ?? "*", `the dotted key \`${fullPath.join(".")}\``);
  });
  // The text mapping must agree with the parser, definition for definition.
  const parsedHooks = normalizedHooks(parsed.hooks);
  for (const kind of new Set([...Object.keys(parsedHooks), ...byKind.keys()])) {
    if (unsupported.has(kind) || unsupported.has("*")) continue;
    const mapped = (byKind.get(kind) ?? []).map((unit) => normalizeHookDef(unit.value));
    if (!isDeepStrictEqualLoose(mapped, parsedHooks[kind] ?? [])) unsupported.set(kind, "a layout pjangler could not map to its text");
  }
  if (parsed.hooks !== undefined && !isTable(parsed.hooks)) unsupported.set("*", "a non-table `hooks` value");
  return { text, lines, statements, parsed, byKind, unsupported, hooksHeader };
}

// ---------------------------------------------------------------------------
// Hook rewrite
// ---------------------------------------------------------------------------

export interface HookRewrite {
  text: string;
  decisions: HookDecisions;
  /** Set when the rewrite could not be made; `text` is then the input, unchanged. */
  refused?: string;
}

const renderString = (value: string) => JSON.stringify(value);

/** The first line of the comment block pjangler writes above its managed hooks. */
const MANAGED_HOOKS_HEADER_MARKER = "# This block will handle the linking of";

function renderHookTable(kind: string, def: unknown): string[] {
  const normalized = normalizeHookDef(def);
  if (isTable(normalized) && Object.keys(normalized).every((key) => !isTable(normalized[key]))) {
    const body = stringifyToml(normalized).replace(/\n+$/, "");
    return [`[[hooks.${kind}]]`, ...(body ? body.split("\n") : [])];
  }
  throw new TomlScanError(`hooks.${kind} holds a definition pjangler cannot render as a table`);
}

function isCommentLine(statement: TomlStatement | undefined): boolean {
  return Boolean(statement && statement.type === "trivia" && statement.comments.length);
}

/**
 * Apply an owner's hook decisions to the text: remove the hooks it claims
 * (whole definitions, or single elements of a `scripts` array), place its
 * managed enter hook once, rename legacy `script`/`scripts` keys when asked,
 * and turn `[hooks] enter/leave = …` keys into `[[hooks.K]]` tables when a
 * change touches them. Everything else keeps its bytes.
 */
export function rewriteMiseHooks(text: string, policy: HookOwnerPolicy): HookRewrite {
  let inventory: HookInventory;
  try {
    inventory = hookInventory(text);
  } catch (error) {
    const reason = `mise.toml could not be read (${error instanceof Error ? error.message : String(error)})`;
    return { text, decisions: { perKind: new Map(), expected: {}, claimed: [], manual: [], canonicalCount: 0, changes: false }, refused: reason };
  }
  const { statements, lines, byKind, unsupported } = inventory;
  const decisions = decideHookDefs(inventory.parsed.hooks, policy);
  const canonical = policy.canonical;
  const edits: LineEdit[] = [];
  const canonicalLines = canonical ? [`[[hooks.enter]]`, `run = ${renderString(canonical)}`] : [];

  const needsRename = (unit: HookUnit): boolean => {
    if (!policy.renameLegacy || !isTable(unit.value)) return false;
    const { shell } = hookCommands(unit.value);
    return !shell && unit.value.run === undefined && (unit.value.script !== undefined || unit.value.scripts !== undefined)
      && !(unit.value.script !== undefined && unit.value.scripts !== undefined);
  };
  const touched = (kind: string): boolean => {
    const list = decisions.perKind.get(kind) ?? [];
    return list.some((decision) => decision.action !== "keep") || (kind === "enter" && decisions.insertCanonicalAt !== undefined);
  };
  for (const kind of decisions.perKind.keys()) {
    const reason = unsupported.get(kind) ?? unsupported.get("*");
    if (reason && touched(kind)) {
      return { text, decisions, refused: `hooks.${kind} is written as ${reason}; pjangler edits only [[hooks.${kind}]] tables and [hooks] keys, so change it by hand` };
    }
  }

  // The command key of a table unit, as a statement.
  const commandStatement = (unit: HookUnit): TomlStatement | undefined => tableBody(statements, unit.statement)
    .find((statement) => statement.path.length === 1 && ["run", "script", "scripts"].includes(statement.path[0]!) && statement.path[0] === hookCommands(unit.value).key);
  const runLines = (statement: TomlStatement, commands: readonly string[]): string[] => {
    const indent = /^\s*/.exec(lines[statement.start]!)![0];
    const value = `${indent}run = ${renderString(commands.join("\n"))}`;
    if (statement.end - statement.start === 1 && statement.comments.length === 1) return [`${value}  ${statement.comments[0]!.trim()}`];
    return [...statement.comments.map((comment) => `${indent}${comment.trim()}`), value];
  };
  const renameEdit = (unit: HookUnit): LineEdit | undefined => {
    const statement = commandStatement(unit);
    if (!statement) return undefined;
    const { commands, key } = hookCommands(unit.value);
    if (key === "script") {
      const renamed = lines[statement.start]!.replace(/^(\s*)script(\s*=)/, "$1run$2");
      return renamed === lines[statement.start] ? undefined : { start: statement.start, end: statement.start + 1, lines: [renamed] };
    }
    if (key === "scripts" && commands) return { start: statement.start, end: statement.end, lines: runLines(statement, commands) };
    return undefined;
  };
  const isExactCanonical = (unit: HookUnit) => (unit.form === "aot" || unit.form === "table")
    && isDeepStrictEqualLoose(unit.value, { run: canonical });
  // Insert before a table unit, above the comment block that introduces it,
  // unless that block is the managed hooks header (which introduces them all).
  const insertionLine = (unit: HookUnit): number => {
    let block = unit.statement;
    while (block > 0 && isCommentLine(statements[block - 1])) block--;
    if (block === unit.statement) return unit.start;
    const comments = statements.slice(block, unit.statement).flatMap((statement) => statement.comments).join("\n");
    if (MANAGED_HOOKS_HEADER_MARKER && comments.includes(MANAGED_HOOKS_HEADER_MARKER)) return unit.start;
    return statements[block]!.start;
  };

  const editable = (kind: string) => !unsupported.has(kind) && !unsupported.has("*");
  try {
  // ---- [[hooks.K]] / [hooks.K] units
  for (const [kind, units] of byKind) {
    if (!editable(kind)) continue;
    const list = decisions.perKind.get(kind) ?? [];
    units.forEach((unit, index) => {
      if (unit.form !== "aot" && unit.form !== "table") return;
      const decision = list[index] ?? { action: "keep" };
      if (kind === "enter" && decisions.insertCanonicalAt === index) {
        edits.push({ start: insertionLine(unit), end: insertionLine(unit), lines: canonicalLines });
        if (unit.form === "table") {
          const header = lines[unit.start]!.replace(/^(\s*)\[([^\]]*)\]/, "$1[[$2]]");
          edits.push({ start: unit.start, end: unit.start + 1, lines: [header] });
        }
      }
      if (decision.action === "drop") {
        edits.push({ start: unit.start, end: unit.end, lines: [] });
      } else if (decision.action === "canonical") {
        if (!isExactCanonical(unit)) edits.push({ start: unit.start, end: unit.end, lines: canonicalLines });
      } else if (decision.action === "reduce") {
        const statement = commandStatement(unit);
        if (!statement) throw new TomlScanError(`hooks.${kind} has no command key to reduce`);
        edits.push({ start: statement.start, end: statement.end, lines: runLines(statement, decision.kept) });
      } else if (needsRename(unit)) {
        const edit = renameEdit(unit);
        if (edit) edits.push(edit);
      }
    });
  }

  // ---- [hooks] keys
  const keyKinds = [...byKind.entries()].filter(([kind, units]) => editable(kind) && units.some((unit) => unit.form === "key" || unit.form === "elem")).map(([kind]) => kind);
  const legacyKey = (kind: string) => (byKind.get(kind) ?? []).some((unit) => isTable(unit.value) && needsRename(unit));
  let convert = keyKinds.filter((kind) => touched(kind) || legacyKey(kind));
  const newEnter = canonical !== undefined && decisions.insertCanonicalAt !== undefined && !byKind.has("enter");
  if (convert.length || (newEnter && inventory.hooksHeader >= 0)) {
    convert = [...new Set([...convert, ...keyKinds.filter((kind) => kind === "enter" || kind === "leave")])];
  }
  const generated: string[] = [];
  if (newEnter && (convert.length || inventory.hooksHeader >= 0)) generated.push(...canonicalLines);
  const keyStatements = new Set<number>();
  for (const kind of convert) {
    const units = byKind.get(kind)!;
    const list = decisions.perKind.get(kind) ?? [];
    const statement = statements[units[0]!.statement]!;
    keyStatements.add(units[0]!.statement);
    edits.push({ start: statement.start, end: statement.end, lines: [] });
    generated.push(...statement.comments.map((comment) => comment.trim()));
    units.forEach((unit, index) => {
      const decision = list[index] ?? { action: "keep" };
      if (kind === "enter" && decisions.insertCanonicalAt === index) generated.push(...canonicalLines);
      if (decision.action === "keep") generated.push(...renderHookTable(kind, unit.value));
      else if (decision.action === "canonical") generated.push(...canonicalLines);
      else if (decision.action === "reduce") generated.push(...renderHookTable(kind, { ...(unit.value as TomlTable), scripts: decision.kept }));
    });
  }
  if (generated.length) {
    // The generated tables go where the [hooks] table ends. A [hooks] table
    // left with no keys loses its header (its trailing comment is kept).
    if (inventory.hooksHeader < 0) {
      return { text, decisions, refused: "pjangler generated [hooks] tables without finding the [hooks] table; change the hooks by hand" };
    }
    const header = statements[inventory.hooksHeader]!;
    const span = tableSpan(statements, inventory.hooksHeader);
    const remaining = span.body.filter((statement) => !keyStatements.has(statements.indexOf(statement)));
    const after = span.end < lines.length && lines[span.end]!.trim() !== "" ? [""] : [];
    if (remaining.length) {
      edits.push({ start: span.end, end: span.end, lines: ["", ...generated, ...after] });
    } else {
      edits.push({ start: header.start, end: header.end, lines: header.comments.map((comment) => comment.trim()) });
      edits.push({ start: span.end, end: span.end, lines: [...generated, ...after] });
    }
  } else if (newEnter) {
    // No hooks.enter anywhere: next to the other hook tables, else before the
    // first watch/task table or the versioning block, else at the end.
    const firstHook = [...byKind.values()].flat().filter((unit) => unit.form === "aot" || unit.form === "table")
      .sort((a, b) => a.start - b.start)[0];
    const block = [...(policy.header && !text.includes(policy.header) ? policy.header.split("\n") : []), ...canonicalLines];
    if (firstHook) {
      edits.push({ start: insertionLine(firstHook), end: insertionLine(firstHook), lines: block });
    } else {
      const anchor = statements.find((statement) => (statement.type === "header" && (statement.path[0] === "watch_files" || statement.path[0] === "tasks"))
        || (statement.type === "trivia" && statement.comments.some((comment) => comment.startsWith("# >>> mise-versioning >>>"))));
      if (anchor) {
        const before = anchor.start > 0 && lines[anchor.start - 1]!.trim() !== "" ? [""] : [];
        edits.push({ start: anchor.start, end: anchor.start, lines: [...before, ...block, ""] });
      } else {
        const last = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
        const before = last > 0 && lines[last - 1]!.trim() !== "" ? [""] : [];
        edits.push({ start: last, end: last, lines: [...before, ...block] });
      }
    }
  }
  return { text: applyLineEdits(text, edits), decisions };
  } catch (error) {
    return { text, decisions, refused: `the hook rewrite could not be laid out (${error instanceof Error ? error.message : String(error)})` };
  }
}

// ---------------------------------------------------------------------------
// Semantic comparison
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted keys, dates by their TOML text. */
export function canonicalJson(value: unknown): string {
  const walk = (entry: unknown): unknown => {
    if (entry instanceof Date) return { $date: String(entry) };
    if (Array.isArray(entry)) return entry.map(walk);
    if (isTable(entry)) return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, walk(entry[key])]));
    return entry;
  };
  return JSON.stringify(walk(value));
}

export function isDeepStrictEqualLoose(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A parsed mise.toml in comparable form: hooks normalized, watch_files order-free. */
export function miseModel(parsed: TomlTable): TomlTable {
  const model: TomlTable = { ...parsed };
  if (isTable(parsed.hooks)) {
    const hooks = normalizedHooks(parsed.hooks);
    if (Object.keys(hooks).length) model.hooks = hooks;
    else delete model.hooks;
  }
  if (Array.isArray(parsed.watch_files)) {
    model.watch_files = [...parsed.watch_files].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    if (!(model.watch_files as unknown[]).length) delete model.watch_files;
  }
  for (const key of ["tasks", "env"]) {
    if (isTable(model[key]) && !Object.keys(model[key] as TomlTable).length) delete model[key];
  }
  return model;
}

/** The first place two comparable models differ, as a dotted path, or undefined. */
export function firstDifference(expected: unknown, actual: unknown, path = ""): string | undefined {
  if (canonicalJson(expected) === canonicalJson(actual)) return undefined;
  if (isTable(expected) && isTable(actual) && path.split(".").length < 3) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const found = firstDifference(expected[key], actual[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return path || "(document)";
}

export function deepClone<T>(value: T): T {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(deepClone) as T;
  if (isTable(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepClone(entry)])) as T;
  return value;
}

export interface RewriteVerdict { ok: boolean; reason?: string }

/**
 * The final guard: `next` must parse, and mean exactly `expected` (a model of
 * the original with only the intended changes applied).
 */
export function checkRewrite(expected: TomlTable, next: string): RewriteVerdict {
  let parsed: TomlTable;
  try {
    parsed = parseToml(next) as TomlTable;
  } catch (error) {
    return { ok: false, reason: `the rewritten file would not parse (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
  const difference = firstDifference(miseModel(expected), miseModel(parsed));
  return difference ? { ok: false, reason: `the rewrite would change ${difference} beyond what it intends` } : { ok: true };
}

/**
 * A mise.toml that does not parse is repaired only for the one corruption
 * pjangler itself once wrote: an orphan `]` line repeating the close of a
 * `[hooks]` array. Anything else is the operator's to fix.
 */
export function parseBaseline(text: string): { text: string; parsed: TomlTable; healed: boolean } | { refused: string } {
  try {
    return { text, parsed: parseToml(text) as TomlTable, healed: false };
  } catch (error) {
    const lines = text.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      const previous = [...kept].reverse().find((entry) => entry.trim() !== "");
      if (/^\s*\]\s*$/.test(line) && previous !== undefined && /\]\s*(?:#.*)?$/.test(previous) && !/^\s*\[/.test(previous)) continue;
      kept.push(line);
    }
    const healed = kept.join("\n");
    if (healed !== text) {
      try {
        return { text: healed, parsed: parseToml(healed) as TomlTable, healed: true };
      } catch { /* fall through */ }
    }
    return { refused: `mise.toml is not valid TOML (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); repair it by hand` };
  }
}
