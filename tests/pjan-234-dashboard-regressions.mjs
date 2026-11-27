import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERMETIC_TMP_BASE, hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(process.argv[2] ?? HERMETIC_TMP_BASE, "pjan-234-"));
const url = "https://holocene.delo.sh/projects/greeninbetween";
let count = 0;
try {
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const source = join(scratch, "cli.mjs");
  const bundled = spawnSync(join(root, "node_modules/.bin/esbuild"), [join(root, "src/index.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${source}`], { encoding: "utf8", env: hermeticEnv() });
  assert.equal(bundled.status, 0, bundled.stderr);
  const gib = join(scratch, "green-in-between");
  const nested = join(gib, "src/deep");
  const child = join(gib, "child");
  const outside = join(scratch, "outside");
  for (const dir of [nested, child, outside]) mkdirSync(dir, { recursive: true });
  const manifest = (dir, data) => writeFileSync(join(dir, ".project.json"), typeof data === "string" ? data : JSON.stringify(data));
  manifest(gib, { project_id: " GreenInBetween ", project_slug: "greeninbetween", project_name: "Not the ID", ticket_provider: { identifier: "POOL" } });
  manifest(child, { project_id: "nested-project" });
  const launcher = join(scratch, "bin");
  mkdirSync(launcher);
  const calls = join(scratch, "calls");
  const fake = join(launcher, "xdg-open");
  const installLauncher = (body) => writeFileSync(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  installLauncher('printf "%s\\n" "$1" >> "$CALLS"');
  const run = (bin, cwd, args = ["dashboard", "--print"], env = {}) => spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: "utf8", env: hermeticEnv({ DISPLAY: "", WAYLAND_DISPLAY: "", SSH_CONNECTION: "", SSH_TTY: "", PATH: launcher, CALLS: calls, ...env }),
  });
  const check = (name, fn) => { fn(); count++; console.log(`ok ${name}`); };
  for (const bin of [source, join(root, "dist/index.js")]) {
    const surface = bin === source ? "source" : "dist";
    for (const dir of [gib, nested]) check(`${surface} GIB root/nested canonical print`, () => {
      rmSync(calls, { force: true });
      const result = run(bin, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${url}\n`);
      assert.equal(existsSync(calls), false);
    });
    check(`${surface} nearer project`, () => assert.equal(run(bin, child).stdout, "https://holocene.delo.sh/projects/nested-project\n"));
    check(`${surface} nested identity fields are not top-level duplicates`, () => {
      const nestedKeys = join(gib, "nested-keys");
      mkdirSync(nestedKeys, { recursive: true });
      manifest(nestedKeys, '{"project_id":"nested-keys","details":{"project_id":"other","project_id":"another"}}');
      const result = run(bin, nestedKeys);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "https://holocene.delo.sh/projects/nested-keys\n");
    });
    check(`${surface} desktop hands off URL and displays link`, () => {
      rmSync(calls, { force: true });
      const result = run(bin, gib, ["dashboard"], { DISPLAY: ":9" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(url));
      assert.equal(readFileSync(calls, "utf8"), `${url}\n`);
    });
    for (const [name, env] of [["headless", {}], ["SSH with display", { DISPLAY: ":9", SSH_CONNECTION: "remote 1 local 22" }]]) {
      check(`${surface} ${name} avoids launcher`, () => {
        rmSync(calls, { force: true });
        const result = run(bin, gib, ["dashboard"], env);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(url));
        assert.match(result.stdout, /no display/);
        assert.equal(existsSync(calls), false);
      });
    }
    check(`${surface} missing launcher fallback`, () => {
      const result = run(bin, gib, ["dashboard"], { DISPLAY: ":9", PATH: join(scratch, "empty") });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(url));
      assert.match(result.stdout, /could not launch/);
      assert.doesNotMatch(result.stderr, /Error:|Unhandled/);
    });
    installLauncher("exit 17");
    check(`${surface} erroring launcher fallback`, () => {
      const result = run(bin, gib, ["dashboard"], { DISPLAY: ":9" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(url));
      assert.match(result.stdout, /could not launch.*17/);
      assert.doesNotMatch(result.stderr, /Error:|Unhandled/);
    });
    installLauncher("kill -TERM $$");
    check(`${surface} signal-terminated launcher fallback`, () => {
      const result = run(bin, gib, ["dashboard"], { DISPLAY: ":9" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(url));
      assert.match(result.stdout, /could not launch.*SIGTERM/);
      assert.doesNotMatch(result.stderr, /Error:|Unhandled/);
    });
    installLauncher('printf "%s\\n" "$1" >> "$CALLS"');
    for (const [name, target] of [["dangling", "missing-manifest"], ["looping", ".project.json"]]) {
      const nearer = join(gib, `${name}-manifest`);
      mkdirSync(nearer, { recursive: true });
      if (bin === source) symlinkSync(target, join(nearer, ".project.json"));
      check(`${surface} refuses nearer ${name} manifest`, () => {
        rmSync(calls, { force: true });
        for (const args of [["dashboard", "--print"], ["dashboard"]]) {
          const result = run(bin, nearer, args, { DISPLAY: ":9" });
          assert.notEqual(result.status, 0, name);
          assert.equal(result.stdout, "", name);
          assert.ok(result.stderr.trim(), name);
          assert.equal(existsSync(calls), false, name);
        }
      });
    }
    const invalid = join(gib, "invalid");
    mkdirSync(invalid, { recursive: true });
    for (const [name, data, dir] of [
      ["outside project", null, outside], ["malformed JSON", "{bad", invalid],
      ["missing ID", { project_name: "Wrong" }, invalid],
      ["legacy slug alone", { project_slug: "legacy" }, invalid],
      ["invalid ID", { project_id: "../greeninbetween" }, invalid],
      ["conflicting IDs", { project_id: "greeninbetween", project_slug: "different" }, invalid],
      ["invalid legacy ID", { project_id: "greeninbetween", project_slug: "../bad" }, invalid],
      ["duplicate canonical ID", '{"project_id":"wrong","project_id":"greeninbetween"}', invalid],
      ["duplicate escaped canonical ID", String.raw`{"project_id":"wrong","project_\u0069d":"greeninbetween"}`, invalid],
      ["duplicate legacy slug", '{"project_id":"greeninbetween","project_slug":"wrong","project_slug":"greeninbetween"}', invalid],
      ["duplicate escaped legacy slug", String.raw`{"project_id":"greeninbetween","project_slug":"wrong","project_\u0073lug":"greeninbetween"}`, invalid],
    ]) {
      check(`${surface} refuses ${name} without launching`, () => {
        if (data !== null) manifest(invalid, data);
        rmSync(calls, { force: true });
        for (const args of [["dashboard", "--print"], ["dashboard"]]) {
          const result = run(bin, dir, args, { DISPLAY: ":9" });
          assert.notEqual(result.status, 0, name);
          assert.equal(result.stdout, "", name);
          assert.ok(result.stderr.trim(), name);
          assert.equal(existsSync(calls), false, name);
        }
      });
    }
  }
  console.log(`PJAN-234: ${count} real-CLI checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
