// The interactive half of `pjangler describe`: tick off findings, press A to
// apply them.
//
// Hand-rolled rather than built on @clack/prompts, for three measured reasons:
//
//   1. @clack's multiselect hard-binds `a` to toggle-ALL
//      (MultiSelectPrompt wires `l.name === "a" && this.toggleAll()`), and
//      readline reports uppercase `A` as `{name:"a", shift:true}` — so the
//      requested "A to apply" collides head-on with a key we cannot rebind.
//   2. `updateSettings({aliases})` cannot help: aliases may only map to the
//      seven built-in actions and are looked up by lowercased key name.
//   3. Subclassing would pull in `@clack/core`, an UNDECLARED transitive
//      dependency that `npm run check:lock` gates.
//
// The design keeps the decision logic pure. `reduceChecklist` is a total
// function from (state, key) to state, and `renderChecklist` is a pure
// function of state — so every interaction can be tested by feeding key
// objects to a reducer, with no pty, no timing, and no TTY. Only `runChecklist`
// touches the terminal, and even that accepts injected streams.

import { emitKeypressEvents } from "node:readline";
import { bold, cyan, dim, glyph, green, padVisible, truncateVisible, yellow } from "../utils/style";

export interface ChecklistItem {
  id: string;
  title: string;
  detail: string;
}

export type ChecklistOutcome = "pending" | "apply" | "cancel";

export interface ChecklistState {
  items: readonly ChecklistItem[];
  /** Ids currently ticked. */
  selected: ReadonlySet<string>;
  cursor: number;
  outcome: ChecklistOutcome;
}

/** The shape node's readline hands to a 'keypress' listener. */
export interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * Everything starts ticked. The common case is "fix all of this", so the
 * cheaper interaction is unticking the few you want to skip — and it removes
 * any need for a toggle-all key, which is exactly the key `A` had to take.
 */
export function createChecklist(items: readonly ChecklistItem[]): ChecklistState {
  return {
    items,
    selected: new Set(items.map((item) => item.id)),
    cursor: 0,
    outcome: "pending",
  };
}

export function selectedIds(state: ChecklistState): string[] {
  return state.items.filter((item) => state.selected.has(item.id)).map((item) => item.id);
}

/** Pure: (state, key) -> state. No IO, no clock, no globals. */
export function reduceChecklist(state: ChecklistState, key: KeyEvent): ChecklistState {
  if (state.outcome !== "pending") return state;
  const last = Math.max(0, state.items.length - 1);

  // Ctrl-C first: it must win regardless of which letter it carries.
  if (key.ctrl && key.name === "c") return { ...state, outcome: "cancel" };

  switch (key.name) {
    case "up":
    case "k":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "down":
    case "j":
      return { ...state, cursor: Math.min(last, state.cursor + 1) };
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: last };
    case "space": {
      const item = state.items[state.cursor];
      if (!item) return state;
      const selected = new Set(state.selected);
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
      return { ...state, selected };
    }
    // `a` covers `A` too: readline lowercases the name and flags shift.
    case "a":
    case "return":
    case "enter":
      return { ...state, outcome: "apply" };
    case "q":
    case "escape":
      return { ...state, outcome: "cancel" };
    default:
      return state;
  }
}

export interface ChecklistRenderOptions {
  width?: number;
  title?: string;
}

/** Pure: state -> frame. */
export function renderChecklist(state: ChecklistState, options: ChecklistRenderOptions = {}): string {
  const width = Math.max(40, Math.min(120, options.width ?? 100));
  const lines: string[] = [""];
  lines.push(`  ${bold(options.title ?? "Select findings to apply")}`);
  lines.push("");

  const idWidth = state.items.reduce((max, item) => Math.max(max, item.title.length), 0);
  for (const [index, item] of state.items.entries()) {
    const onCursor = index === state.cursor;
    const ticked = state.selected.has(item.id);
    const pointer = onCursor ? cyan(glyph.chevron) : " ";
    const box = ticked ? green(glyph.pass) : dim(glyph.skip);
    // Pad the RAW title, then color — padding a colored string is a no-op.
    const title = padVisible(ticked ? bold(item.title) : dim(item.title), idWidth);
    const detail = truncateVisible(item.detail, Math.max(10, width - idWidth - 10));
    lines.push(`  ${pointer} ${box} ${title}  ${dim(detail)}`);
  }

  lines.push("");
  const count = selectedIds(state).length;
  const legend = [
    `${cyan("↑↓")} move`,
    `${cyan("space")} toggle`,
    `${cyan("A")} apply`,
    `${cyan("q")} quit`,
  ].join(dim(" · "));
  const tally = count ? green(`${count} selected`) : yellow("none selected");
  lines.push(`  ${legend}   ${tally}`);
  return lines.join("\n");
}

/**
 * The narrow slice of a readable stream this loop needs.
 *
 * Declared structurally rather than as `NodeJS.ReadableStream & {…}`: that
 * intersection produces overload sets TypeScript cannot reconcile for `.on`,
 * and the wide type would let a caller pass a stream we do not actually drive.
 */
export interface KeyInputStream {
  on(event: "keypress", listener: (chunk: string, key: KeyEvent | undefined) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  removeListener(event: "keypress", listener: (chunk: string, key: KeyEvent | undefined) => void): unknown;
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface KeyOutputStream {
  write(chunk: string): unknown;
}

export interface RunChecklistOptions {
  items: readonly ChecklistItem[];
  input?: KeyInputStream;
  output?: KeyOutputStream;
  width?: number;
  title?: string;
}

export interface ChecklistResult {
  outcome: Exclude<ChecklistOutcome, "pending">;
  selected: string[];
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Drive the checklist against a terminal.
 *
 * Streams are injected so tests can drive the real loop over a PassThrough
 * with no pty involved; the raw-mode call is guarded by `isTTY`, which node
 * already requires.
 */
export function runChecklist(options: RunChecklistOptions): Promise<ChecklistResult> {
  const input: KeyInputStream = options.input ?? (process.stdin as unknown as KeyInputStream);
  const output: KeyOutputStream = options.output ?? process.stdout;

  return new Promise((resolve) => {
    let state = createChecklist(options.items);
    let previousLines = 0;

    const draw = () => {
      const frame = renderChecklist(state, { width: options.width, title: options.title });
      // Rewind over the previous frame and clear to the end of the screen,
      // so successive frames overwrite rather than scroll.
      if (previousLines > 0) output.write(`\x1b[${previousLines}A\x1b[0J`);
      output.write(`${frame}\n`);
      previousLines = frame.split("\n").length;
    };

    const onKey = (_chunk: string, key: KeyEvent | undefined) => {
      if (!key) return;
      const next = reduceChecklist(state, key);
      if (next === state) return;
      state = next;
      if (state.outcome === "pending") {
        draw();
        return;
      }
      cleanup();
      resolve({ outcome: state.outcome, selected: state.outcome === "apply" ? selectedIds(state) : [] });
    };

    const cleanup = () => {
      input.removeListener("keypress", onKey);
      if (input.isTTY) input.setRawMode?.(false);
      input.pause?.();
      output.write(SHOW_CURSOR);
    };

    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    if (input.isTTY) input.setRawMode?.(true);
    input.resume?.();
    output.write(HIDE_CURSOR);
    draw();
    input.on("keypress", onKey);

    // A stream that ends without a decision (piped input running out) is a
    // cancel, not a hang.
    input.once("end", () => {
      if (state.outcome !== "pending") return;
      cleanup();
      resolve({ outcome: "cancel", selected: [] });
    });
  });
}
