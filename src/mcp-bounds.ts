import { createHash } from "node:crypto";

export const MCP_OUTPUT_BYTES = 256 * 1024;
export const MCP_CAPTURE_BYTES = 64 * 1024;
export const MCP_PAGE_SIZE = 100;
export const MCP_MAX_PAGE_SIZE = 500;

export interface CaptureBudget { serializedBytes: number; maxSerializedBytes: number }

/** A byte-bound collector: never keep a discarded suffix in an array or a phase. */
export class BoundedCapture {
  readonly entries: string[] = [];
  bytes = 0;
  omittedCount = 0;
  readonly maxBytes: number;
  readonly shared?: CaptureBudget;
  constructor(maxBytes = MCP_CAPTURE_BYTES, shared?: CaptureBudget) { this.maxBytes = maxBytes; this.shared = shared; }

  append(value: string): string | undefined {
    const remaining = Math.min(this.maxBytes - this.bytes, this.shared ? this.shared.maxSerializedBytes - this.shared.serializedBytes : Infinity);
    if (remaining <= 0) { this.omittedCount++; return undefined; }
    let kept = "";
    let used = 0;
    let serializedBytes = 2 + (this.entries.length ? 1 : 0);
    // JSON escaping can cost more bytes than raw UTF-8.
    for (const point of value) {
      const cost = Buffer.byteLength(point, "utf8");
      const escaped = Buffer.byteLength(JSON.stringify(point), "utf8") - 2;
      if (used + cost > remaining || (this.shared && this.shared.serializedBytes + serializedBytes + escaped > this.shared.maxSerializedBytes)) break;
      kept += point;
      used += cost;
      serializedBytes += escaped;
    }
    if (kept) {
      this.entries.push(kept);
      this.bytes += used;
      if (this.shared) this.shared.serializedBytes += serializedBytes;
    }
    if (kept.length < value.length) this.omittedCount++;
    return kept || undefined;
  }
}

export interface PageMeta {
  limit: number;
  truncated: boolean;
  omittedCount: number;
  nextCursor?: string;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Cursor binds an offset to the ordered identities, without exposing either to clients. */
function token(index: number, identity: string): string {
  return Buffer.from(JSON.stringify([index, identity])).toString("base64url");
}

export function paginate<T>(
  items: readonly T[], identityPart: (item: T) => string, limit: number | undefined, cursor: string | undefined,
  render: (page: T[], meta: PageMeta) => object,
  readable?: (payload: object) => string,
): { payload: object; page: T[]; meta: PageMeta } {
  const size = limit ?? MCP_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MCP_MAX_PAGE_SIZE) throw new Error(`limit must be a positive integer at most ${MCP_MAX_PAGE_SIZE}`);
  const digest = createHash("sha256");
  for (const item of items) {
    const part = identityPart(item);
    digest.update(String(Buffer.byteLength(part, "utf8"))).update(":").update(part);
  }
  const identity = digest.digest("hex");
  let start = 0;
  if (cursor !== undefined) {
    try {
      const raw = Buffer.from(cursor, "base64url").toString("utf8");
      if (Buffer.from(raw).toString("base64url") !== cursor) throw new Error("noncanonical cursor");
      const decoded: unknown = JSON.parse(raw);
      if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || decoded[0] < 1 || decoded[0] >= items.length || decoded[1] !== identity) throw new Error("stale cursor");
      start = decoded[0];
    } catch { throw new Error("Invalid or stale cursor"); }
  }
  const make = (end: number) => {
    const nextCursor = end < items.length ? token(end, identity) : undefined;
    const meta: PageMeta = { limit: size, truncated: end < items.length, omittedCount: items.length - end, ...(nextCursor ? { nextCursor } : {}) };
    const page = items.slice(start, end);
    return { payload: render(page, meta), page, meta };
  };
  let last = make(start);
  // Avoid materializing or serializing the entire dataset; only admitted page
  // records enter the envelope. Count the full serialized envelope each time.
  for (let end = start + 1; end <= Math.min(items.length, start + size); end++) {
    const candidate = make(end);
    if (bytes(candidate.payload) > MCP_OUTPUT_BYTES || (readable && Buffer.byteLength(readable(candidate.payload), "utf8") > MCP_OUTPUT_BYTES)) break;
    last = candidate;
  }
  if (start < items.length && last.page.length === 0) throw new Error("First unreturned item exceeds the MCP 256 KiB structured output budget");
  if (bytes(last.payload) > MCP_OUTPUT_BYTES || (readable && Buffer.byteLength(readable(last.payload), "utf8") > MCP_OUTPUT_BYTES)) throw new Error("MCP envelope exceeds the 256 KiB output budget");
  return last;
}

/** Capture is already bounded upstream; refuse rather than emit an oversized envelope. */
export function boundedPayload<T extends object>(payload: T): T {
  if (bytes(payload) > MCP_OUTPUT_BYTES) throw new Error("MCP envelope exceeds the 256 KiB structured output budget");
  return payload;
}
