import { describe, expect, it } from "bun:test";
import { createRunnableCommand, getRunnableCommandInfo, getRunnableCommandNames } from "./registry";

describe("runnable command registry", () => {
  it("resolves canonical runnable command name", () => {
    const info = getRunnableCommandInfo("sync-docs");
    expect(info?.name).toBe("sync-docs");
  });

  it("resolves alias to canonical runnable command", () => {
    const info = getRunnableCommandInfo("syncDocs");
    expect(info?.name).toBe("sync-docs");
  });

  it("resolves alias case-insensitively", () => {
    const info = getRunnableCommandInfo("SYNCDOCS");
    expect(info?.name).toBe("sync-docs");
  });

  it("does not resolve non-runnable command names", () => {
    const info = getRunnableCommandInfo("AddDotenv");
    expect(info).toBeNull();
  });

  it("creates runnable command instance", () => {
    const command = createRunnableCommand("sync-docs", {
      targetDir: process.cwd(),
      dryRun: true,
      args: { since: "24 hours ago", flat: false }
    });
    expect(command).not.toBeNull();
  });

  it("lists runnable commands", () => {
    expect(getRunnableCommandNames()).toContain("sync-docs");
  });
});
