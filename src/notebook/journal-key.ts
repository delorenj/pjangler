import { createHash } from "node:crypto";
import { NotebookError } from "./types";

export type JournalPeriod = "daily" | "weekly" | "monthly";

export function validateJournalPeriodKey(period: JournalPeriod, key: string): void {
  if (period === "monthly") {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(key)) throw new NotebookError("INVALID_INPUT", "Monthly period key must be YYYY-MM");
    return;
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(key)) {
    throw new NotebookError("INVALID_INPUT", `${period} period key must be YYYY-MM-DD`);
  }
  const date = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    throw new NotebookError("INVALID_INPUT", "Period key is not a calendar date");
  }
  if (period === "weekly" && date.getUTCDay() !== 1) {
    throw new NotebookError("INVALID_INPUT", "Weekly period key must be a Monday");
  }
}

/** A UUID-shaped, deterministic user-note identity for one Infra journal period. */
export function journalNoteOperationId(period: JournalPeriod, key: string): string {
  validateJournalPeriodKey(period, key);
  const bytes = createHash("sha256").update(`pjangler-dev-journal-v1\0infra\0${period}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
