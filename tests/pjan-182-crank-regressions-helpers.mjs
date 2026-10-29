// Helpers for tests/pjan-182-crank-interval-regressions.mjs: a throwaway redis-server and
// Ink-compatible fake terminal streams. Kept out of the suite so the suite reads as claims.

import { spawn } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { Writable } from "node:stream";

/** A free TCP port (never 6379: that is the live crank engine's Redis). */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Start `redis-server` on a free port with persistence off; resolves { port, stop() }. */
export async function startThrowawayRedis() {
  const port = await freePort();
  if (port === 6379) throw new Error("refusing to use the live crank Redis port");
  const child = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
    env: hermeticEnv(),
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const { spawnSync } = await import("node:child_process");
  const ping = () => spawnSync("redis-cli", ["-h", "127.0.0.1", "-p", String(port), "PING"], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();
  for (let i = 0; i < 100; i++) {
    if (ping() === "PONG") break;
    await new Promise((r) => setTimeout(r, 50));
    if (i === 99) {
      child.kill("SIGKILL");
      throw new Error("throwaway redis-server did not come up");
    }
  }
  return {
    port,
    cli: (...args) => spawnSync("redis-cli", ["--raw", "-h", "127.0.0.1", "-p", String(port), ...args], { encoding: "utf8", env: hermeticEnv() }).stdout.replace(/\r?\n$/, ""),
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      child.kill("SIGKILL");
    },
  };
}

/** A TTY-looking stdin Ink will put in raw mode; `press` feeds it bytes. */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  #queue = [];
  setRawMode() { return this; }
  setEncoding() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return this.#queue.shift() ?? null; }
  press(text) {
    this.#queue.push(text);
    this.emit("readable");
  }
}

/** A TTY-looking stdout that records every write; `frame()` is the most recent Ink frame. */
export class FakeStdout extends Writable {
  isTTY = true;
  columns = 110;
  rows = 40;
  chunks = [];
  _write(chunk, _encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }
  /** All text written so far with ANSI escapes removed. */
  text() {
    // eslint-disable-next-line no-control-regex
    return this.chunks.join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  }
  /** The most recent full frame (Ink's `debug` mode writes one whole frame per render). */
  frame() {
    // eslint-disable-next-line no-control-regex
    return (this.chunks.at(-1) ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

/** Resolve once `predicate()` is true (polls), or throw with `what`. */
export async function waitFor(predicate, what, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
