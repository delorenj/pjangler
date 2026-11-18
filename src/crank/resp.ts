// A tiny RESP2 client over node:net, builtins only (no redis-cli, no client dependency).
//
// The shell prompt (dist/prompt.js) reads the crank arbiter's resolved hash on EVERY Enter, so it
// cannot afford a redis-cli spawn: it pipelines its HGETALLs down one TCP connection under a hard
// total timeout. The detached refresher uses it for the same reason. Never throws, never leaves a
// socket open: any failure (refused, reset, timeout, junk) resolves to undefined, which the caller
// reads as "Redis did not answer" and never as "the value is absent".

import { connect } from "node:net";

/** One RESP2 reply: a status/bulk string, an integer, nil, an array, or a server error. */
export type RespReply = string | number | null | RespReply[] | { error: string };

/**
 * Parse one reply from `buf` at `offset`. undefined = the buffer ends mid-reply (read more);
 * a protocol violation throws. Bulk strings are decoded as UTF-8 by their BYTE length.
 */
export function parseResp(buf: Buffer, offset = 0): { value: RespReply; next: number } | undefined {
  if (offset >= buf.length) return undefined;
  const eol = buf.indexOf("\r\n", offset, "latin1");
  if (eol < 0) return undefined;
  const type = String.fromCharCode(buf[offset] as number);
  const head = buf.toString("utf8", offset + 1, eol);
  const after = eol + 2;
  switch (type) {
    case "+": return { value: head, next: after };
    case "-": return { value: { error: head }, next: after };
    case ":": return { value: Number(head), next: after };
    case "$": {
      const length = Number(head);
      if (length < 0) return { value: null, next: after };
      if (buf.length < after + length + 2) return undefined;
      return { value: buf.toString("utf8", after, after + length), next: after + length + 2 };
    }
    case "*": {
      const count = Number(head);
      if (count < 0) return { value: null, next: after };
      const items: RespReply[] = [];
      let cursor = after;
      for (let i = 0; i < count; i++) {
        const item = parseResp(buf, cursor);
        if (!item) return undefined;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`not RESP2: ${JSON.stringify(type)}`);
  }
}

/** A command as the RESP array of bulk strings Redis expects. */
export function encodeCommand(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Run `commands` pipelined on ONE connection and resolve their replies in order, or undefined when
 * the whole exchange did not finish within `timeoutMs` (connect + write + read, in total).
 */
export function redisPipeline(
  endpoint: { host: string; port: number },
  commands: string[][],
  timeoutMs: number,
): Promise<RespReply[] | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const replies: RespReply[] = [];
    let pending: Buffer = Buffer.alloc(0);
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const finish = (value: RespReply[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref();
    socket.setNoDelay(true);
    socket.on("error", () => finish(undefined));
    socket.on("close", () => finish(undefined));
    socket.on("connect", () => {
      socket.write(Buffer.concat(commands.map((command) => encodeCommand(command))));
    });
    socket.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      try {
        for (;;) {
          const parsed = parseResp(pending);
          if (!parsed) break;
          replies.push(parsed.value);
          pending = pending.subarray(parsed.next);
          if (replies.length === commands.length) return finish(replies);
        }
      } catch {
        finish(undefined);
      }
    });
  });
}

/** A flat HGETALL-style reply as an object; undefined when it is not one. An empty hash is {}. */
export function replyToHash(reply: RespReply | undefined): Record<string, string> | undefined {
  if (!Array.isArray(reply)) return undefined;
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < reply.length; i += 2) {
    const key = reply[i];
    const value = reply[i + 1];
    if (typeof key === "string" && typeof value === "string") out[key] = value;
  }
  return out;
}
