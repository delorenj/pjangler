// Terminal rendering for `pj board` reads.
//
// Split from `boardQuery.ts` so the query layer stays free of presentation:
// the MCP server and any future consumer want the normalized objects, not a
// table. Every renderer here is pure — it takes data and a clock and returns
// lines — so the layout is testable without a terminal.

import type { BoardModule, BoardTicket } from "./boardQuery";
import { formatCompactAge } from "../describe/activity";
import {
  cyan,
  dim,
  gray,
  green,
  padVisible,
  red,
  terminalWidth,
  truncateVisible,
  yellow,
} from "../utils/style";

type Colorize = (value: string | number) => string;

/** Widest a state column may grow before it is truncated. */
const MAX_STATE_WIDTH = 18;

/** Group → color. Unknown groups stay uncolored rather than guessing. */
function stateColor(group: string): Colorize {
  switch (group) {
    case "started":
      return yellow;
    case "completed":
      return green;
    case "cancelled":
      return red;
    case "backlog":
    case "unstarted":
      return dim;
    default:
      return (value) => String(value);
  }
}

/** `3h`, `2d`, `now` — or `—` when the provider gave no usable stamp. */
function age(stamp: string, now: Date): string {
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return "—";
  return formatCompactAge((now.getTime() - parsed) / 1000);
}

export interface TicketTableOptions {
  now?: Date;
  /** Terminal width; injected so layout is testable off a tty. */
  width?: number;
}

/**
 * One line per ticket: reference, age, state, title.
 *
 * Columns are padded on the RAW strings before coloring — `padEnd` counts
 * escape bytes toward the target width, so pad-then-color is the only ordering
 * that actually aligns.
 */
export function formatTicketTable(tickets: readonly BoardTicket[], options: TicketTableOptions = {}): string[] {
  if (!tickets.length) return [];
  const now = options.now ?? new Date();
  const width = options.width ?? terminalWidth();

  const ages = tickets.map((ticket) => age(ticket.touchedAt, now));
  const keyWidth = Math.max(...tickets.map((ticket) => ticket.key.length));
  const ageWidth = Math.max(...ages.map((value) => value.length));
  // Column names are the board's, not ours: "Complete but Unacknowledged" is a
  // real state here. Capped so one verbose column cannot eat the titles.
  const stateWidth = Math.min(MAX_STATE_WIDTH, Math.max(...tickets.map((ticket) => ticket.state.length)));

  // 2 leading spaces + three single-space gutters between four columns.
  const titleWidth = Math.max(12, width - (2 + keyWidth + 1 + ageWidth + 1 + stateWidth + 1));

  return tickets.map((ticket, index) => {
    const key = cyan(ticket.key.padEnd(keyWidth));
    const stamp = dim((ages[index] ?? "").padStart(ageWidth));
    const state = stateColor(ticket.stateGroup)(truncateVisible(ticket.state, stateWidth).padEnd(stateWidth));
    const title = truncateVisible(ticket.title, titleWidth);
    return `  ${key} ${stamp} ${state} ${title}`;
  });
}

export interface ModuleListOptions {
  now?: Date;
  width?: number;
}

/**
 * One line per module: name, progress, status, age.
 *
 * Progress is `done/total` rather than a percentage — a module with 1 of 8
 * issues closed is more legible as `1/8` than as `13%`, and it does not invent
 * precision the board does not have.
 */
export function formatModuleList(modules: readonly BoardModule[], options: ModuleListOptions = {}): string[] {
  if (!modules.length) return [];
  const now = options.now ?? new Date();
  const width = options.width ?? terminalWidth();

  const progress = modules.map((module) => `${module.completedIssues}/${module.totalIssues}`);
  const ages = modules.map((module) => age(module.updatedAt, now));
  const progressWidth = Math.max(...progress.map((value) => value.length));
  const ageWidth = Math.max(...ages.map((value) => value.length));
  const statusWidth = Math.max(...modules.map((module) => module.status.length));

  // Fit the content, not the terminal: a five-module board should not pad its
  // first column out to 80 columns just because the window is wide.
  const available = Math.max(12, width - (2 + progressWidth + 1 + statusWidth + 1 + ageWidth + 1));
  const nameWidth = Math.min(available, Math.max(...modules.map((module) => module.name.length)));

  return modules.map((module, index) => {
    const name = padVisible(truncateVisible(module.name, nameWidth), nameWidth);
    const done = dim((progress[index] ?? "").padStart(progressWidth));
    const status = statusColor(module.status)((module.status || "").padEnd(statusWidth));
    const stamp = dim((ages[index] ?? "").padStart(ageWidth));
    return `  ${name} ${done} ${status} ${stamp}`;
  });
}

/** Module status vocabulary is Plane's own: backlog/planned/in-progress/… */
function statusColor(status: string): Colorize {
  switch (status) {
    case "in-progress":
      return yellow;
    case "completed":
      return green;
    case "cancelled":
      return red;
    case "paused":
      return gray;
    default:
      return dim;
  }
}
