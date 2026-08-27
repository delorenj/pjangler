import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const temp = mkdtempSync(join(tmpdir(), "pjan-86-hermes-deploy-"));
const EXPECTED_HERMES_GITLINK = "b35150d0be0be6d7b5e6d5d6c2347c8ff5123a50";

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function runAsync(args, cwd, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone, rejectDone) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDone(new Error(`async CLI timed out: ${args.join(" ")}`));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectDone(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveDone({ status, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitForPath(path, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}: ${path}`);
}

async function waitForChildCommand(parentPid, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const children = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      for (const pid of children) {
        const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (command === expected) return Number(pid);
      }
    } catch {
      // The process tree is still settling; the outer timeout remains bounded.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${expected} child of pid ${parentPid}`);
}

function committedHermesTemplate(path) {
  const tree = spawnSync("git", ["ls-tree", "HEAD", "templates/hermes-agent"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const match = tree.stdout.match(/^160000 commit ([0-9a-f]{40})\ttemplates\/hermes-agent\s*$/);
  assert.ok(match, `HEAD must commit an exact Hermes template gitlink, got: ${tree.stdout}`);
  const gitlink = match[1];
  assert.equal(
    gitlink,
    EXPECTED_HERMES_GITLINK,
    "PJAN-86 must test the final reviewed Hermes template commit, never an advanced mutable worktree",
  );
  const show = spawnSync("git", ["-C", join(root, "templates", "hermes-agent"), "show", `${gitlink}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(show.status, 0, `committed Hermes gitlink ${gitlink} cannot provide ${path}: ${show.stderr}`);
  return { gitlink, content: show.stdout };
}

let openSocketServer;
try {
  const fakeBin = join(temp, "bin");
  const copierSentinel = join(temp, "copier-ran");
  mkdirSync(fakeBin, { recursive: true });
  const fakeCopier = join(fakeBin, "copier");
  writeFileSync(fakeCopier, `#!/usr/bin/env sh\n: > "${copierSentinel}"\nexit 91\n`);
  chmodSync(fakeCopier, 0o755);
  const commandEnv = {
    HOME: join(temp, "home"),
    XDG_CONFIG_HOME: join(temp, "xdg"),
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    COLUMNS: "0",
    PJANGLER_HERMES_TEMPLATE: "",
  };

  // Command-level dry-run: a zero-width terminal must still get readable,
  // mode-aware output and absolutely no repo/host mutation.
  const previewRepo = join(temp, "preview-repo");
  mkdirSync(previewRepo, { recursive: true });
  const preview = run(["hermes-agent", "--yes", "--dry-run"], previewRepo, commandEnv);
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewOutput = `${preview.stdout}\n${preview.stderr}`;
  assert.match(previewOutput, /Hermes deployment plan \(no changes applied\)/);
  assert.match(previewOutput, /runtime: local role runtime/);
  assert.match(previewOutput, /dry-run made no repository or host changes/);
  assert.doesNotMatch(previewOutput, /Provisioned|\bDone\.|runtime:\s*gh:/);
  assert.equal(existsSync(join(previewRepo, "agents")), false, "dry-run must not render a role");
  assert.equal(existsSync(join(temp, "xdg", "hermes-agent-template", "config.toml")), false, "dry-run must not create host config");
  assert.equal(existsSync(copierSentinel), false, "dry-run must not execute Copier");

  const hermesHelp = run(["hermes-agent", "--help"], previewRepo, commandEnv);
  assert.equal(hermesHelp.status, 0, hermesHelp.stderr);
  assert.match(hermesHelp.stdout, /--skip-runtime-repo\s+Deprecated no-op; Hermes always uses ignored\s+role-local runtime state/);
  assert.doesNotMatch(hermesHelp.stdout, /create.*runtime.*(?:GitHub|GH)|runtime.*repo.*creation/i);

  // --email has no pinned template interface and must fail before even config
  // bootstrap or Copier discovery/execution.
  const emailRepo = join(temp, "email-repo");
  mkdirSync(emailRepo, { recursive: true });
  const emailConfig = join(temp, "email-xdg");
  const email = run(["hermes-agent", "--yes", "--email"], emailRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: emailConfig,
  });
  assert.notEqual(email.status, 0);
  assert.match(`${email.stdout}\n${email.stderr}`, /pinned Hermes template has no supported email provisioner/);
  assert.equal(existsSync(join(emailRepo, "agents")), false, "unsupported email must fail before repo mutation");
  assert.equal(existsSync(emailConfig), false, "unsupported email must fail before host config mutation");
  assert.equal(existsSync(copierSentinel), false, "unsupported email must fail before Copier");

  // Any meaningful partial render is existing user state. --yes must refuse it
  // before config bootstrap or Copier, even when role.yaml does not exist yet.
  const partialRepo = join(temp, "partial-repo");
  const partialRoleDir = join(partialRepo, "agents", "hermes", "pm");
  const partialSoul = join(partialRoleDir, "SOUL.md");
  mkdirSync(partialRoleDir, { recursive: true });
  writeFileSync(partialSoul, "precious partial soul\n");
  const partialConfig = join(temp, "partial-xdg");
  const partial = run(["hermes-agent", "--yes"], partialRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: partialConfig,
  });
  assert.notEqual(partial.status, 0);
  assert.match(`${partial.stdout}\n${partial.stderr}`, /target directory is not empty.*SOUL\.md.*--force/s);
  assert.equal(readFileSync(partialSoul, "utf8"), "precious partial soul\n");
  assert.equal(existsSync(partialConfig), false, "partial-role refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "partial-role refusal must precede Copier");

  // Empty directory structure and inert placeholder/OS metadata are the only
  // harmless existing entries. Ignored runtime state remains a blocker.
  const placeholderRepo = join(temp, "placeholder-repo");
  const placeholderRole = join(placeholderRepo, "agents", "hermes", "pm");
  mkdirSync(join(placeholderRole, "empty-child"), { recursive: true });
  writeFileSync(join(placeholderRole, ".gitkeep"), "");
  writeFileSync(join(placeholderRole, ".DS_Store"), "metadata");
  const placeholder = run(["hermes-agent", "--yes", "--dry-run"], placeholderRepo, commandEnv);
  assert.equal(placeholder.status, 0, `${placeholder.stdout}\n${placeholder.stderr}`);

  // A placeholder name never makes a symlink harmless. Reject both dangling
  // and live links before even host-config bootstrap or Copier execution.
  for (const [label, placeholderName, target] of [
    ["dangling", ".gitkeep", "missing-placeholder-target"],
    ["live", ".DS_Store", join(temp, "live-placeholder-target")],
  ]) {
    const symlinkRepo = join(temp, `${label}-placeholder-symlink-repo`);
    const symlinkRole = join(symlinkRepo, "agents", "hermes", "pm");
    const symlinkPath = join(symlinkRole, placeholderName);
    const symlinkConfig = join(temp, `${label}-placeholder-symlink-xdg`);
    mkdirSync(symlinkRole, { recursive: true });
    if (label === "live") writeFileSync(target, "outside role\n");
    symlinkSync(target, symlinkPath);
    const blocked = run(["hermes-agent", "--yes"], symlinkRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: symlinkConfig,
    });
    assert.notEqual(blocked.status, 0, `${label} placeholder symlink must be rejected`);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, new RegExp(placeholderName.replace(".", "\\.")));
    assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(symlinkPath), target);
    assert.equal(existsSync(symlinkConfig), false, `${label} placeholder symlink refusal must precede config mutation`);
    assert.equal(existsSync(copierSentinel), false, `${label} placeholder symlink refusal must precede Copier`);
  }

  // Placeholder names are harmless only for single-link regular files. A
  // FIFO, Unix socket, device node (where the host permits one), or hardlink
  // must be rejected without opening the entry or starting any later phase.
  const specialPlaceholders = [];

  const fifoRepo = join(temp, "fifo-placeholder-repo");
  const fifoRole = join(fifoRepo, "agents", "hermes", "pm");
  const fifoPath = join(fifoRole, ".gitkeep");
  mkdirSync(fifoRole, { recursive: true });
  const madeFifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(madeFifo.status, 0, madeFifo.stderr);
  specialPlaceholders.push(["FIFO", fifoRepo, fifoPath, (stats) => stats.isFIFO()]);

  const socketRepo = join(temp, "socket-placeholder-repo");
  const socketRole = join(socketRepo, "agents", "hermes", "pm");
  const socketPath = join(socketRole, ".DS_Store");
  mkdirSync(socketRole, { recursive: true });
  const socketServer = createServer();
  openSocketServer = socketServer;
  await new Promise((resolveListen, rejectListen) => {
    socketServer.once("error", rejectListen);
    socketServer.listen(socketPath, resolveListen);
  });
  specialPlaceholders.push(["socket", socketRepo, socketPath, (stats) => stats.isSocket()]);

  const hardlinkRepo = join(temp, "hardlink-placeholder-repo");
  const hardlinkRole = join(hardlinkRepo, "agents", "hermes", "pm");
  const hardlinkSource = join(temp, "hardlink-placeholder-source");
  const hardlinkPath = join(hardlinkRole, "Thumbs.db");
  mkdirSync(hardlinkRole, { recursive: true });
  writeFileSync(hardlinkSource, "operator-owned hardlink bytes\n");
  linkSync(hardlinkSource, hardlinkPath);
  specialPlaceholders.push(["hardlink", hardlinkRepo, hardlinkPath, (stats) => stats.isFile() && stats.nlink > 1]);

  // Device nodes require CAP_MKNOD and are unavailable in ordinary CI/user
  // namespaces. Exercise one when permitted; the source-level isFile tripwire
  // below deterministically covers the same classifier everywhere else.
  const deviceRepo = join(temp, "device-placeholder-repo");
  const deviceRole = join(deviceRepo, "agents", "hermes", "pm");
  const devicePath = join(deviceRole, ".gitkeep");
  mkdirSync(deviceRole, { recursive: true });
  const madeDevice = spawnSync("mknod", [devicePath, "c", "1", "3"], { encoding: "utf8" });
  if (madeDevice.status === 0) {
    specialPlaceholders.push(["device", deviceRepo, devicePath, (stats) => stats.isCharacterDevice()]);
  }

  for (const [label, repo, path, expectedType] of specialPlaceholders) {
    const before = lstatSync(path);
    assert.equal(expectedType(before), true, `${label} fixture must have the intended file type`);
    const specialConfig = join(temp, `${label}-placeholder-xdg`);
    const blocked = run(["hermes-agent", "--yes"], repo, {
      ...commandEnv,
      XDG_CONFIG_HOME: specialConfig,
    });
    assert.notEqual(blocked.status, 0, `${label} placeholder must be rejected`);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /\.gitkeep|\.DS_Store|Thumbs\.db/);
    const after = lstatSync(path);
    assert.equal(expectedType(after), true, `${label} placeholder type must remain unchanged`);
    assert.equal(after.ino, before.ino, `${label} placeholder inode must remain unchanged`);
    assert.equal(after.nlink, before.nlink, `${label} placeholder link count must remain unchanged`);
    assert.equal(existsSync(specialConfig), false, `${label} refusal must precede config mutation`);
    assert.equal(existsSync(copierSentinel), false, `${label} refusal must precede Copier`);
  }
  await new Promise((resolveClose, rejectClose) => {
    socketServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  openSocketServer = undefined;
  assert.equal(readFileSync(hardlinkSource, "utf8"), "operator-owned hardlink bytes\n");

  const runtimeRepo = join(temp, "runtime-only-repo");
  const runtimeState = join(runtimeRepo, "agents", "hermes", "pm", "runtime", "checkpoint.json");
  mkdirSync(join(runtimeRepo, "agents", "hermes", "pm", "runtime"), { recursive: true });
  writeFileSync(runtimeState, "{}\n");
  const runtimeOnly = run(["hermes-agent", "--yes", "--dry-run"], runtimeRepo, commandEnv);
  assert.notEqual(runtimeOnly.status, 0);
  assert.match(`${runtimeOnly.stdout}\n${runtimeOnly.stderr}`, /runtime\/checkpoint\.json/);

  // --yes means defaults, not implicit destructive overwrite consent.
  const existingRepo = join(temp, "existing-repo");
  const existingRole = join(existingRepo, "agents", "hermes", "pm", "role.yaml");
  mkdirSync(join(existingRepo, "agents", "hermes", "pm"), { recursive: true });
  const preciousRole = "repo: existing-repo\nrole: pm\nagent_id: existing-repo-pm\n# precious\n";
  writeFileSync(existingRole, preciousRole);
  const existingConfig = join(temp, "existing-xdg");
  const overwrite = run(["hermes-agent", "--yes"], existingRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: existingConfig,
  });
  assert.notEqual(overwrite.status, 0);
  assert.match(`${overwrite.stdout}\n${overwrite.stderr}`, /non-interactive mode will not render into it.*--force/s);
  assert.equal(readFileSync(existingRole, "utf8"), preciousRole);
  assert.equal(existsSync(existingConfig), false, "overwrite refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "overwrite refusal must precede Copier");

  // Standalone bootstrap reports successful plans and changes to process
  // callers; silence here previously made a real write look like a no-op.
  const bootstrapRepo = join(temp, "bootstrap-repo");
  const bootstrapHome = join(temp, "bootstrap-xdg");
  const bootstrapPath = join(bootstrapHome, "hermes-agent-template", "config.toml");
  mkdirSync(bootstrapRepo, { recursive: true });
  const bootstrapPlan = run(["config", "bootstrap", "--dry-run"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrapPlan.status, 0, bootstrapPlan.stderr);
  assert.match(bootstrapPlan.stdout, /\[DRY RUN\] Would create config:/);
  assert.equal(existsSync(bootstrapPath), false);
  const bootstrap = run(["config", "bootstrap"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /Bootstrapped config without replacing existing values:/);
  assert.equal(existsSync(bootstrapPath), true);

  // The config leaf is lstat'd before any force/exists/read branch. Live and
  // dangling symlinks plus every tested special-file form fail unchanged; in
  // particular, a FIFO must never be opened and hang the command.
  for (const [label, target, targetExists] of [
    ["live-config-symlink", join(temp, "live-config-target.toml"), true],
    ["dangling-config-symlink", join(temp, "missing-config-target.toml"), false],
  ]) {
    const unsafeHome = join(temp, `${label}-xdg`);
    const unsafePath = join(unsafeHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(unsafeHome, "hermes-agent-template"), { recursive: true });
    if (targetExists) writeFileSync(target, "[fleet]\noperator = true\n");
    symlinkSync(target, unsafePath);
    const beforeTarget = targetExists ? readFileSync(target) : undefined;
    const rejected = run(["config", "bootstrap"], bootstrapRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: unsafeHome,
    });
    assert.notEqual(rejected.status, 0, `${label} must fail closed`);
    assert.match(rejected.stderr, /expected a regular file, found symbolic link/);
    assert.equal(lstatSync(unsafePath).isSymbolicLink(), true);
    assert.equal(readlinkSync(unsafePath), target);
    if (targetExists) assert.equal(readFileSync(target).equals(beforeTarget), true);
    else assert.equal(existsSync(target), false);
  }

  const directoryConfigHome = join(temp, "directory-config-xdg");
  const directoryConfigPath = join(directoryConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(directoryConfigPath, { recursive: true });
  writeFileSync(join(directoryConfigPath, "operator-sentinel"), "keep\n");
  const directoryConfig = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: directoryConfigHome,
  });
  assert.notEqual(directoryConfig.status, 0);
  assert.match(directoryConfig.stderr, /expected a regular file, found directory/);
  assert.equal(readFileSync(join(directoryConfigPath, "operator-sentinel"), "utf8"), "keep\n");

  const fifoConfigHome = join(temp, "fifo-config-xdg");
  const fifoConfigPath = join(fifoConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(fifoConfigHome, "hermes-agent-template"), { recursive: true });
  const madeConfigFifo = spawnSync("mkfifo", [fifoConfigPath], { encoding: "utf8" });
  assert.equal(madeConfigFifo.status, 0, madeConfigFifo.stderr);
  const fifoConfig = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: fifoConfigHome,
  });
  assert.notEqual(fifoConfig.status, 0);
  assert.notEqual(fifoConfig.error?.code, "ETIMEDOUT", "config FIFO refusal must not hang on a read");
  assert.match(fifoConfig.stderr, /expected a regular file, found FIFO/);
  assert.equal(lstatSync(fifoConfigPath).isFIFO(), true);

  const socketConfigHome = join(temp, "socket-config-xdg");
  const socketConfigPath = join(socketConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(socketConfigHome, "hermes-agent-template"), { recursive: true });
  const configSocketServer = createServer();
  openSocketServer = configSocketServer;
  await new Promise((resolveListen, rejectListen) => {
    configSocketServer.once("error", rejectListen);
    configSocketServer.listen(socketConfigPath, resolveListen);
  });
  const socketConfig = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: socketConfigHome,
  });
  assert.notEqual(socketConfig.status, 0);
  assert.match(socketConfig.stderr, /expected a regular file, found socket/);
  assert.equal(lstatSync(socketConfigPath).isSocket(), true);
  await new Promise((resolveClose, rejectClose) => {
    configSocketServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  openSocketServer = undefined;

  // Validation must exactly match the deployed Python tomllib consumer and
  // operate on bytes, not Node's replacement-character UTF-8 decoding.
  const invalidTomlCases = [
    [
      "toml-11-escape",
      Buffer.concat([Buffer.from("[fleet]\nvalue = \"", "utf8"), Buffer.from([0x5c, 0x65]), Buffer.from("\"\n", "utf8")]),
      /TOMLDecodeError/,
    ],
    ["invalid-calendar-date", Buffer.from("[fleet]\nvalue = 2023-02-30\n", "utf8"), /TOMLDecodeError|day is out of range/],
    [
      "invalid-utf8",
      Buffer.concat([Buffer.from("[fleet]\nvalue = \"", "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from("\"\n", "utf8")]),
      /UnicodeDecodeError/,
    ],
  ];
  for (const [label, source, expectedError] of invalidTomlCases) {
    const invalidHome = join(temp, `${label}-xdg`);
    const invalidPath = join(invalidHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(invalidHome, "hermes-agent-template"), { recursive: true });
    writeFileSync(invalidPath, source);
    const before = statSync(invalidPath);
    const invalid = run(["config", "bootstrap", "--force"], bootstrapRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: invalidHome,
    });
    assert.notEqual(invalid.status, 0, `${label} must fail tomllib validation`);
    assert.match(invalid.stderr, /not valid TOML 1\.0 for Python tomllib/);
    assert.match(invalid.stderr, expectedError);
    assert.doesNotMatch(invalid.stdout, /Updated|Bootstrapped/);
    assert.equal(readFileSync(invalidPath).equals(source), true, `${label} must preserve exact bytes`);
    const after = statSync(invalidPath);
    assert.equal(after.ino, before.ino, `${label} must not replace the file`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${label} must not write the file`);
  }

  const noPythonHome = join(temp, "no-python-xdg");
  const noPythonPath = join(noPythonHome, "hermes-agent-template", "config.toml");
  const noPythonSource = Buffer.from("[fleet]\nhermes_bin = \"/operator/hermes\"\n", "utf8");
  mkdirSync(join(noPythonHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(noPythonPath, noPythonSource);
  const noPythonBefore = statSync(noPythonPath);
  const noPython = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: noPythonHome,
  });
  assert.notEqual(noPython.status, 0);
  assert.match(noPython.stderr, /python3 with tomllib is required but was not found/);
  assert.equal(readFileSync(noPythonPath).equals(noPythonSource), true);
  assert.equal(statSync(noPythonPath).ino, noPythonBefore.ino);

  // Python validation is an isolated stdlib boundary. Neither a cwd-local
  // tomllib.py nor one injected through PYTHONPATH may execute, and no
  // PYTHON* environment entry may reach even the selected python3 executable.
  const systemPython = spawnSync("which", ["python3"], { encoding: "utf8" });
  assert.equal(systemPython.status, 0, systemPython.stderr);
  const isolatedPythonBin = join(temp, "isolated-python-bin");
  const localImportSentinel = join(temp, "local-tomllib-imported");
  const pathImportSentinel = join(temp, "pythonpath-tomllib-imported");
  const environmentLeakSentinel = join(temp, "python-environment-leaked");
  const flagLeakSentinel = join(temp, "python-isolation-flags-missing");
  mkdirSync(isolatedPythonBin, { recursive: true });
  const isolatedPythonWrapper = join(isolatedPythonBin, "python3");
  writeFileSync(isolatedPythonWrapper, `#!/bin/sh
if /usr/bin/env | /usr/bin/grep -q '^PYTHON'; then
  : > "$VALIDATOR_ENV_LEAK_SENTINEL"
fi
if [ "$1" != "-I" ] || [ "$2" != "-S" ] || [ "$3" != "-c" ]; then
  : > "$VALIDATOR_FLAG_LEAK_SENTINEL"
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(isolatedPythonWrapper, 0o755);
  writeFileSync(join(bootstrapRepo, "tomllib.py"), `
import os
open(os.environ["LOCAL_TOMLLIB_SENTINEL"], "w", encoding="utf-8").write("imported\\n")
class TOMLDecodeError(Exception):
    pass
def loads(_source):
    return {}
`);
  const poisonedPythonPath = join(temp, "poisoned-pythonpath");
  mkdirSync(poisonedPythonPath, { recursive: true });
  writeFileSync(join(poisonedPythonPath, "tomllib.py"), `
import os
open(os.environ["PATH_TOMLLIB_SENTINEL"], "w", encoding="utf-8").write("imported\\n")
class TOMLDecodeError(Exception):
    pass
def loads(_source):
    return {}
`);
  const isolatedHome = join(temp, "isolated-validator-xdg");
  const isolatedPath = join(isolatedHome, "hermes-agent-template", "config.toml");
  const isolatedInvalidSource = Buffer.concat([
    Buffer.from("[fleet]\nvalue = \"", "utf8"),
    Buffer.from([0x5c, 0x65]),
    Buffer.from("\"\n", "utf8"),
  ]);
  mkdirSync(join(isolatedHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(isolatedPath, isolatedInvalidSource);
  const isolatedBefore = statSync(isolatedPath);
  const isolatedValidation = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${isolatedPythonBin}${delimiter}${commandEnv.PATH}`,
    PYTHONHOME: join(temp, "hostile-python-home"),
    PYTHONPATH: poisonedPythonPath,
    PYTHONSTARTUP: join(temp, "hostile-python-startup.py"),
    PYTHONWARNINGS: "error",
    LOCAL_TOMLLIB_SENTINEL: localImportSentinel,
    PATH_TOMLLIB_SENTINEL: pathImportSentinel,
    VALIDATOR_ENV_LEAK_SENTINEL: environmentLeakSentinel,
    VALIDATOR_FLAG_LEAK_SENTINEL: flagLeakSentinel,
    XDG_CONFIG_HOME: isolatedHome,
  });
  assert.notEqual(isolatedValidation.status, 0);
  assert.match(isolatedValidation.stderr, /not valid TOML 1\.0 for Python tomllib.*TOMLDecodeError/s);
  assert.doesNotMatch(isolatedValidation.stdout, /Updated|Bootstrapped/);
  assert.equal(existsSync(localImportSentinel), false, "cwd-local tomllib must not execute");
  assert.equal(existsSync(pathImportSentinel), false, "PYTHONPATH tomllib must not execute while the local poison is present");
  assert.equal(existsSync(environmentLeakSentinel), false, "PYTHON* entries must be removed from the validator child env");
  assert.equal(existsSync(flagLeakSentinel), false, "validator must invoke python3 with -I -S before -c");
  assert.equal(readFileSync(isolatedPath).equals(isolatedInvalidSource), true);
  const isolatedAfter = statSync(isolatedPath);
  assert.equal(isolatedAfter.ino, isolatedBefore.ino);
  assert.equal(isolatedAfter.mtimeMs, isolatedBefore.mtimeMs);

  // Repeat from a cwd without the local module so the PYTHONPATH poison is an
  // independently reachable import candidate under a non-isolated invocation.
  const pathPoisonRepo = join(temp, "pythonpath-poison-repo");
  const pathPoisonHome = join(temp, "pythonpath-validator-xdg");
  const pathPoisonConfig = join(pathPoisonHome, "hermes-agent-template", "config.toml");
  mkdirSync(pathPoisonRepo, { recursive: true });
  mkdirSync(join(pathPoisonHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(pathPoisonConfig, isolatedInvalidSource);
  const pathPoisonBefore = statSync(pathPoisonConfig);
  const pathPoisonValidation = run(["config", "bootstrap", "--force"], pathPoisonRepo, {
    ...commandEnv,
    PATH: `${isolatedPythonBin}${delimiter}${commandEnv.PATH}`,
    PYTHONPATH: poisonedPythonPath,
    PATH_TOMLLIB_SENTINEL: pathImportSentinel,
    VALIDATOR_ENV_LEAK_SENTINEL: environmentLeakSentinel,
    VALIDATOR_FLAG_LEAK_SENTINEL: flagLeakSentinel,
    XDG_CONFIG_HOME: pathPoisonHome,
  });
  assert.notEqual(pathPoisonValidation.status, 0);
  assert.match(pathPoisonValidation.stderr, /not valid TOML 1\.0 for Python tomllib.*TOMLDecodeError/s);
  assert.equal(existsSync(pathImportSentinel), false, "PYTHONPATH tomllib must not execute without a local poison module");
  assert.equal(existsSync(environmentLeakSentinel), false);
  assert.equal(existsSync(flagLeakSentinel), false);
  assert.equal(readFileSync(pathPoisonConfig).equals(isolatedInvalidSource), true);
  const pathPoisonAfter = statSync(pathPoisonConfig);
  assert.equal(pathPoisonAfter.ino, pathPoisonBefore.ino);
  assert.equal(pathPoisonAfter.mtimeMs, pathPoisonBefore.mtimeMs);

  // A stuck interpreter is bounded and reported as a validator timeout without
  // touching the operator's exact bytes or file identity.
  const timeoutPythonBin = join(temp, "timeout-python-bin");
  const timeoutPython = join(timeoutPythonBin, "python3");
  mkdirSync(timeoutPythonBin, { recursive: true });
  writeFileSync(timeoutPython, "#!/bin/sh\nexec /bin/sleep 30\n");
  chmodSync(timeoutPython, 0o755);
  const timeoutHome = join(temp, "timeout-validator-xdg");
  const timeoutPath = join(timeoutHome, "hermes-agent-template", "config.toml");
  const timeoutSource = Buffer.from("[fleet]\nhermes_bin = \"/operator/hermes\"\n", "utf8");
  mkdirSync(join(timeoutHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(timeoutPath, timeoutSource);
  const timeoutBefore = statSync(timeoutPath);
  const timedOut = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: timeoutPythonBin,
    XDG_CONFIG_HOME: timeoutHome,
  });
  assert.notEqual(timedOut.status, 0);
  assert.notEqual(timedOut.error?.code, "ETIMEDOUT", "CLI must report its validator timeout before the outer process timeout");
  assert.match(timedOut.stderr, /no changes were applied: Existing Hermes template config validation timed out after 5000ms/);
  assert.doesNotMatch(timedOut.stdout, /Updated|Bootstrapped/);
  assert.equal(readFileSync(timeoutPath).equals(timeoutSource), true);
  const timeoutAfter = statSync(timeoutPath);
  assert.equal(timeoutAfter.ino, timeoutBefore.ino);
  assert.equal(timeoutAfter.mtimeMs, timeoutBefore.mtimeMs);

  // Calls 1-5 validate the existing, merged, rendered, and staged bytes. Call
  // 6 observes then hangs on the installed candidate; call 7 observes then
  // hangs during best-effort post-restore verification. The original inode is
  // already canonical before call 7 and neither timeout can block restoration.
  const rollbackPythonBin = join(temp, "rollback-python-bin");
  const rollbackPython = join(rollbackPythonBin, "python3");
  const rollbackCallCount = join(temp, "rollback-validator-call-count");
  const candidateInodeSentinel = join(temp, "installed-candidate-inode");
  const restoredInodeSentinel = join(temp, "post-restore-inode");
  mkdirSync(rollbackPythonBin, { recursive: true });
  writeFileSync(rollbackPython, `#!/bin/sh
count=0
if [ -f "$VALIDATOR_CALL_COUNT" ]; then
  count=$(/bin/cat "$VALIDATOR_CALL_COUNT")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$VALIDATOR_CALL_COUNT"
if [ "$count" -eq 6 ]; then
  /usr/bin/stat -c '%i' "$VALIDATOR_CONFIG_PATH" > "$VALIDATOR_CANDIDATE_INODE"
  exec /bin/sleep 30
fi
if [ "$count" -eq 7 ]; then
  /usr/bin/stat -c '%i' "$VALIDATOR_CONFIG_PATH" > "$VALIDATOR_RESTORED_INODE"
  exec /bin/sleep 30
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(rollbackPython, 0o755);
  const rollbackHome = join(temp, "post-install-rollback-xdg");
  const rollbackDirectory = join(rollbackHome, "hermes-agent-template");
  const rollbackPath = join(rollbackDirectory, "config.toml");
  const rollbackSource = Buffer.from("# exact operator bytes\n[fleet]\nhermes_bin = \"/operator/hermes\"\n", "utf8");
  mkdirSync(rollbackDirectory, { recursive: true });
  writeFileSync(rollbackPath, rollbackSource);
  chmodSync(rollbackPath, 0o640);
  const preservedMtime = new Date("2024-01-02T03:04:05.000Z");
  utimesSync(rollbackPath, preservedMtime, preservedMtime);
  const rollbackBefore = statSync(rollbackPath);
  const postInstallFailure = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${rollbackPythonBin}${delimiter}${commandEnv.PATH}`,
    VALIDATOR_CALL_COUNT: rollbackCallCount,
    VALIDATOR_CONFIG_PATH: rollbackPath,
    VALIDATOR_CANDIDATE_INODE: candidateInodeSentinel,
    VALIDATOR_RESTORED_INODE: restoredInodeSentinel,
    XDG_CONFIG_HOME: rollbackHome,
  });
  assert.notEqual(postInstallFailure.status, 0);
  assert.notEqual(postInstallFailure.error?.code, "ETIMEDOUT", "both bounded validator failures must finish before the outer CLI timeout");
  assert.match(postInstallFailure.stderr, /Installed Hermes template config validation timed out after 5000ms/);
  assert.match(postInstallFailure.stderr, /original Hermes config was restored before post-restore verification failed: Post-restore Hermes template config validation timed out after 5000ms/);
  assert.equal(readFileSync(rollbackCallCount, "utf8").trim(), "7");
  const candidateInode = Number(readFileSync(candidateInodeSentinel, "utf8").trim());
  const restoredObservedInode = Number(readFileSync(restoredInodeSentinel, "utf8").trim());
  assert.notEqual(candidateInode, rollbackBefore.ino, "call 6 must observe the installed candidate inode");
  assert.equal(restoredObservedInode, rollbackBefore.ino, "call 7 must run only after the original inode is restored");
  assert.equal(readFileSync(rollbackPath).equals(rollbackSource), true);
  const rollbackAfter = statSync(rollbackPath);
  assert.equal(rollbackAfter.ino, rollbackBefore.ino);
  assert.equal(rollbackAfter.mtimeMs, rollbackBefore.mtimeMs);
  assert.equal(rollbackAfter.mode & 0o777, rollbackBefore.mode & 0o777);
  assert.deepEqual(
    readdirSync(rollbackDirectory).filter((name) => name.startsWith(".pjangler-config-txn-")),
    [],
    "restoration must remove the candidate and all transaction artifacts",
  );

  // A pre-existing alias means the protected inode can be mutated through a
  // pathname outside this transaction. Reject link count 2 before parsing,
  // staging, linking, or changing either alias.
  const aliasHome = join(temp, "hardlinked-config-xdg");
  const aliasDirectory = join(aliasHome, "hermes-agent-template");
  const aliasPath = join(aliasDirectory, "config.toml");
  const aliasOtherPath = join(aliasDirectory, "operator-alias.toml");
  const aliasPythonBin = join(temp, "hardlink-python-bin");
  const aliasPython = join(aliasPythonBin, "python3");
  const aliasPythonSentinel = join(temp, "hardlink-python-ran");
  const aliasSource = Buffer.from("# multiply linked operator config\n[fleet]\nhermes_bin = \"/operator/alias\"\n", "utf8");
  mkdirSync(aliasDirectory, { recursive: true });
  mkdirSync(aliasPythonBin, { recursive: true });
  writeFileSync(aliasPath, aliasSource);
  chmodSync(aliasPath, 0o640);
  utimesSync(aliasPath, preservedMtime, preservedMtime);
  linkSync(aliasPath, aliasOtherPath);
  writeFileSync(aliasPython, `#!/bin/sh
: > "$ALIAS_PYTHON_SENTINEL"
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(aliasPython, 0o755);
  const aliasBefore = statSync(aliasPath);
  assert.equal(aliasBefore.nlink, 2);
  const aliasRejected = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${aliasPythonBin}${delimiter}${commandEnv.PATH}`,
    ALIAS_PYTHON_SENTINEL: aliasPythonSentinel,
    XDG_CONFIG_HOME: aliasHome,
  });
  assert.notEqual(aliasRejected.status, 0);
  assert.match(aliasRejected.stderr, /unsafe link count 2; expected exactly 1/);
  assert.equal(existsSync(aliasPythonSentinel), false, "multiply linked config must fail before TOML validation");
  for (const path of [aliasPath, aliasOtherPath]) {
    assert.equal(readFileSync(path).equals(aliasSource), true);
    const after = statSync(path);
    assert.equal(after.ino, aliasBefore.ino);
    assert.equal(after.mtimeMs, aliasBefore.mtimeMs);
    assert.equal(after.mode & 0o777, aliasBefore.mode & 0o777);
    assert.equal(after.nlink, 2);
  }
  assert.deepEqual(
    readdirSync(aliasDirectory).filter((name) => name.startsWith(".pjangler-config-txn-")),
    [],
    "unsafe original topology must fail before transaction creation",
  );

  // Deterministically replace the canonical leaf after protection/link checks
  // but immediately before renameat2(EXCHANGE). A Node preload intercepts only
  // the bounded atomic-helper spawn, so this is a process-level reproduction of
  // the old check-to-rename window without a production test hook.
  const exchangeRaceHome = join(temp, "exchange-window-xdg");
  const exchangeRaceDirectory = join(exchangeRaceHome, "hermes-agent-template");
  const exchangeRacePath = join(exchangeRaceDirectory, "config.toml");
  const exchangeRaceStage = join(exchangeRaceDirectory, "external-replacement.toml");
  const exchangeRacePreload = join(temp, "exchange-window-preload.cjs");
  const exchangeRaceSentinel = join(temp, "exchange-window-injected");
  const exchangeRaceOriginal = Buffer.from("# original before exchange window\n[fleet]\nhermes_bin = \"/operator/exchange-original\"\n", "utf8");
  const exchangeRaceReplacement = Buffer.from("# replacement in exchange window\n[fleet]\nhermes_bin = \"/operator/exchange-newer\"\n", "utf8");
  mkdirSync(exchangeRaceDirectory, { recursive: true });
  writeFileSync(exchangeRacePath, exchangeRaceOriginal);
  chmodSync(exchangeRacePath, 0o640);
  utimesSync(exchangeRacePath, preservedMtime, preservedMtime);
  const exchangeRaceOriginalStats = statSync(exchangeRacePath);
  writeFileSync(exchangeRaceStage, exchangeRaceReplacement);
  chmodSync(exchangeRaceStage, 0o600);
  const exchangeRaceMtime = new Date("2025-03-04T05:06:07.000Z");
  utimesSync(exchangeRaceStage, exchangeRaceMtime, exchangeRaceMtime);
  const exchangeRaceReplacementStats = statSync(exchangeRaceStage);
  writeFileSync(exchangeRacePreload, `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalSpawnSync = childProcess.spawnSync;
let injected = false;
childProcess.spawnSync = function(command, args, options) {
  if (!injected && Array.isArray(args) && args.some((value) => typeof value === "string" && value.includes("PJANGLER_RENAMEAT2_HELPER"))) {
    injected = true;
    fs.renameSync(${JSON.stringify(exchangeRaceStage)}, ${JSON.stringify(exchangeRacePath)});
    fs.writeFileSync(${JSON.stringify(exchangeRaceSentinel)}, "injected\\n");
  }
  return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
`);
  const exchangeRace = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    NODE_OPTIONS: `--require=${exchangeRacePreload}`,
    XDG_CONFIG_HOME: exchangeRaceHome,
  });
  assert.notEqual(exchangeRace.status, 0);
  assert.equal(existsSync(exchangeRaceSentinel), true, "preload must inject exactly at the atomic helper boundary");
  assert.match(exchangeRace.stderr, /Atomic Hermes config install captured an unexpected canonical inode/);
  assert.match(exchangeRace.stderr, /canonical Hermes config was preserved/);
  assert.equal(readFileSync(exchangeRacePath).equals(exchangeRaceReplacement), true);
  const exchangeRaceAfter = statSync(exchangeRacePath);
  assert.equal(exchangeRaceAfter.dev, exchangeRaceReplacementStats.dev);
  assert.equal(exchangeRaceAfter.ino, exchangeRaceReplacementStats.ino);
  assert.equal(exchangeRaceAfter.mtimeMs, exchangeRaceReplacementStats.mtimeMs);
  assert.equal(exchangeRaceAfter.mode & 0o777, exchangeRaceReplacementStats.mode & 0o777);
  const exchangeRaceTransactions = readdirSync(exchangeRaceDirectory).filter((name) => name.startsWith(".pjangler-config-txn-"));
  assert.equal(exchangeRaceTransactions.length, 1);
  const exchangeRaceTransaction = join(exchangeRaceDirectory, exchangeRaceTransactions[0]);
  const exchangeRaceMarker = JSON.parse(readFileSync(join(exchangeRaceTransaction, "state.json"), "utf8"));
  assert.equal(exchangeRaceMarker.phase, "conflict");
  assert.equal(readFileSync(join(exchangeRaceTransaction, "operator-config")).equals(exchangeRaceOriginal), true);
  const exchangeRaceProtected = statSync(join(exchangeRaceTransaction, "operator-config"));
  assert.equal(exchangeRaceProtected.ino, exchangeRaceOriginalStats.ino);
  assert.equal(exchangeRaceProtected.nlink, 1);
  assert.ok(
    readdirSync(exchangeRaceTransaction).includes("candidate.toml"),
    "reversed install exchange must retain its staged candidate",
  );

  // A bounded helper timeout has an unknown syscall outcome. It must retain
  // the journal, staged candidate, and protected original instead of assuming
  // renameat2 did not run and deleting recovery state.
  const helperTimeoutHome = join(temp, "atomic-helper-timeout-xdg");
  const helperTimeoutDirectory = join(helperTimeoutHome, "hermes-agent-template");
  const helperTimeoutPath = join(helperTimeoutDirectory, "config.toml");
  const helperTimeoutPreload = join(temp, "atomic-helper-timeout-preload.cjs");
  const helperTimeoutSentinel = join(temp, "atomic-helper-timeout-injected");
  const helperTimeoutOriginal = Buffer.from("# original before helper timeout\n[fleet]\nhermes_bin = \"/operator/helper-timeout\"\n", "utf8");
  mkdirSync(helperTimeoutDirectory, { recursive: true });
  writeFileSync(helperTimeoutPath, helperTimeoutOriginal);
  chmodSync(helperTimeoutPath, 0o640);
  utimesSync(helperTimeoutPath, preservedMtime, preservedMtime);
  const helperTimeoutBefore = statSync(helperTimeoutPath);
  writeFileSync(helperTimeoutPreload, `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalSpawnSync = childProcess.spawnSync;
let injected = false;
childProcess.spawnSync = function(command, args, options) {
  if (!injected && Array.isArray(args) && args.some((value) => typeof value === "string" && value.includes("PJANGLER_RENAMEAT2_HELPER"))) {
    injected = true;
    fs.writeFileSync(${JSON.stringify(helperTimeoutSentinel)}, "injected\\n");
    const error = new Error("fixture helper timeout");
    error.code = "ETIMEDOUT";
    return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: "SIGKILL", error };
  }
  return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
`);
  const helperTimeout = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    NODE_OPTIONS: `--require=${helperTimeoutPreload}`,
    XDG_CONFIG_HOME: helperTimeoutHome,
  });
  assert.notEqual(helperTimeout.status, 0);
  assert.equal(existsSync(helperTimeoutSentinel), true);
  assert.match(helperTimeout.stderr, /syscall completion is unknown/);
  assert.match(helperTimeout.stderr, /retained for manual recovery/);
  assert.equal(readFileSync(helperTimeoutPath).equals(helperTimeoutOriginal), true);
  const helperTimeoutAfter = statSync(helperTimeoutPath);
  assert.equal(helperTimeoutAfter.ino, helperTimeoutBefore.ino);
  assert.equal(helperTimeoutAfter.mtimeMs, helperTimeoutBefore.mtimeMs);
  assert.equal(helperTimeoutAfter.mode & 0o777, helperTimeoutBefore.mode & 0o777);
  assert.equal(helperTimeoutAfter.nlink, 2, "protected original must remain linked after unknown helper outcome");
  const helperTimeoutTransactions = readdirSync(helperTimeoutDirectory).filter((name) => name.startsWith(".pjangler-config-txn-"));
  assert.equal(helperTimeoutTransactions.length, 1);
  const helperTimeoutTransaction = join(helperTimeoutDirectory, helperTimeoutTransactions[0]);
  assert.equal(JSON.parse(readFileSync(join(helperTimeoutTransaction, "state.json"), "utf8")).phase, "conflict");
  assert.equal(readFileSync(join(helperTimeoutTransaction, "operator-config")).equals(helperTimeoutOriginal), true);
  assert.equal(existsSync(join(helperTimeoutTransaction, "candidate.toml")), true);

  // A non-cooperating writer replaces the canonical leaf while installed TOML
  // validation is paused. The failed installer must not rename the protected
  // original over those newer bytes. Both valid and torn recovery markers must
  // keep refusing automatic recovery without changing the replacement.
  const casPythonBin = join(temp, "cas-python-bin");
  const casPython = join(casPythonBin, "python3");
  const casCallCount = join(temp, "cas-validator-call-count");
  const casReady = join(temp, "cas-installed-validation-ready");
  const casRelease = join(temp, "cas-installed-validation-release");
  mkdirSync(casPythonBin, { recursive: true });
  writeFileSync(casPython, `#!/bin/sh
count=0
if [ -f "$CAS_CALL_COUNT" ]; then
  count=$(/bin/cat "$CAS_CALL_COUNT")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$CAS_CALL_COUNT"
if [ "$count" -eq 6 ]; then
  : > "$CAS_READY"
  while [ ! -e "$CAS_RELEASE" ]; do
    /bin/sleep 0.02
  done
  printf '%s\n' 'TOML_INVALID:forced installed validation failure' >&2
  exit 1
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(casPython, 0o755);
  const casHome = join(temp, "cas-conflict-xdg");
  const casDirectory = join(casHome, "hermes-agent-template");
  const casPath = join(casDirectory, "config.toml");
  const casReplacementStage = join(casDirectory, "replacement.toml");
  const casOriginal = Buffer.from("# original before CAS conflict\n[fleet]\nhermes_bin = \"/operator/original\"\n", "utf8");
  const casReplacement = Buffer.from("# newer non-cooperating writer\n[fleet]\nhermes_bin = \"/operator/newer\"\n", "utf8");
  mkdirSync(casDirectory, { recursive: true });
  writeFileSync(casPath, casOriginal);
  chmodSync(casPath, 0o640);
  utimesSync(casPath, preservedMtime, preservedMtime);
  const casOriginalStats = statSync(casPath);
  const casWriter = runAsync(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${casPythonBin}${delimiter}${commandEnv.PATH}`,
    CAS_CALL_COUNT: casCallCount,
    CAS_READY: casReady,
    CAS_RELEASE: casRelease,
    XDG_CONFIG_HOME: casHome,
  });
  await waitForPath(casReady, "installed candidate validation pause");
  const installedCandidateStats = statSync(casPath);
  assert.notEqual(installedCandidateStats.ino, casOriginalStats.ino);
  writeFileSync(casReplacementStage, casReplacement);
  chmodSync(casReplacementStage, 0o600);
  const replacementMtime = new Date("2025-02-03T04:05:06.000Z");
  utimesSync(casReplacementStage, replacementMtime, replacementMtime);
  const stagedReplacementStats = statSync(casReplacementStage);
  renameSync(casReplacementStage, casPath);
  writeFileSync(casRelease, "release\n");
  const casFailure = await casWriter.done;
  assert.notEqual(casFailure.status, 0);
  assert.match(casFailure.stderr, /Installed Hermes template config is not valid TOML 1\.0/);
  assert.match(casFailure.stderr, /canonical Hermes config changed after candidate installation/);
  assert.match(casFailure.stderr, /canonical Hermes config was preserved/);
  assert.match(casFailure.stderr, /retained for manual recovery/);
  assert.equal(readFileSync(casCallCount, "utf8").trim(), "6", "conflict must skip post-restore validation");
  const assertReplacementPreserved = () => {
    assert.equal(readFileSync(casPath).equals(casReplacement), true);
    const current = statSync(casPath);
    assert.equal(current.dev, stagedReplacementStats.dev);
    assert.equal(current.ino, stagedReplacementStats.ino);
    assert.equal(current.mtimeMs, stagedReplacementStats.mtimeMs);
    assert.equal(current.mode & 0o777, stagedReplacementStats.mode & 0o777);
    assert.equal(current.nlink, 1);
  };
  assertReplacementPreserved();
  const casTransactions = readdirSync(casDirectory).filter((name) => name.startsWith(".pjangler-config-txn-"));
  assert.equal(casTransactions.length, 1, "CAS conflict must retain exactly one protected transaction");
  const casTransaction = join(casDirectory, casTransactions[0]);
  const casOperatorPath = join(casTransaction, "operator-config");
  const casStatePath = join(casTransaction, "state.json");
  assert.equal(readFileSync(casOperatorPath).equals(casOriginal), true);
  const casProtectedStats = statSync(casOperatorPath);
  assert.equal(casProtectedStats.ino, casOriginalStats.ino);
  assert.equal(casProtectedStats.mtimeMs, casOriginalStats.mtimeMs);
  assert.equal(casProtectedStats.nlink, 1);
  const conflictMarker = JSON.parse(readFileSync(casStatePath, "utf8"));
  assert.equal(conflictMarker.phase, "conflict");

  const recordedConflictRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: casHome,
  });
  assert.notEqual(recordedConflictRecovery.status, 0);
  assert.match(recordedConflictRecovery.stderr, /recorded a concurrent canonical-path conflict/);
  assert.match(recordedConflictRecovery.stderr, /retained for manual recovery/);
  assertReplacementPreserved();
  assert.equal(existsSync(casTransaction), true);

  writeFileSync(casStatePath, `${JSON.stringify({ ...conflictMarker, phase: "prepared" })}\n`, { mode: 0o600 });
  const preparedCrashRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: casHome,
  });
  assert.notEqual(preparedCrashRecovery.status, 0);
  assert.match(preparedCrashRecovery.stderr, /Canonical Hermes config before recovery rollback intent/);
  assert.match(preparedCrashRecovery.stderr, /retained for manual recovery/);
  assertReplacementPreserved();
  assert.equal(existsSync(casTransaction), true);

  renameSync(casStatePath, join(casTransaction, "state-next.json"));
  const tornCrashRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: casHome,
  });
  assert.notEqual(tornCrashRecovery.status, 0);
  assert.match(tornCrashRecovery.stderr, /transaction metadata is torn or incomplete/);
  assert.match(tornCrashRecovery.stderr, /retained for manual recovery/);
  assertReplacementPreserved();
  assert.equal(existsSync(casTransaction), true);

  // A valid replacement arriving while the installed candidate's consumer
  // validation is paused must also fail closed. The validator succeeds, then
  // the committed-marker/live-CAS boundary detects the new inode without ever
  // exchanging it out of the canonical path.
  const successCasPythonBin = join(temp, "success-cas-python-bin");
  const successCasPython = join(successCasPythonBin, "python3");
  const successCasCalls = join(temp, "success-cas-validator-calls");
  const successCasReady = join(temp, "success-cas-validation-ready");
  const successCasRelease = join(temp, "success-cas-validation-release");
  mkdirSync(successCasPythonBin, { recursive: true });
  writeFileSync(successCasPython, `#!/bin/sh
count=0
if [ -f "$SUCCESS_CAS_CALLS" ]; then
  count=$(/bin/cat "$SUCCESS_CAS_CALLS")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$SUCCESS_CAS_CALLS"
if [ "$count" -eq 6 ]; then
  : > "$SUCCESS_CAS_READY"
  while [ ! -e "$SUCCESS_CAS_RELEASE" ]; do
    /bin/sleep 0.02
  done
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(successCasPython, 0o755);
  const successCasHome = join(temp, "success-cas-xdg");
  const successCasDirectory = join(successCasHome, "hermes-agent-template");
  const successCasPath = join(successCasDirectory, "config.toml");
  const successCasReplacementStage = join(successCasDirectory, "newer-valid.toml");
  const successCasOriginal = Buffer.from("# original before successful validation race\n[fleet]\nhermes_bin = \"/operator/success-original\"\n", "utf8");
  const successCasReplacement = Buffer.from("# newer valid config during validation\n[fleet]\nhermes_bin = \"/operator/success-newer\"\n", "utf8");
  mkdirSync(successCasDirectory, { recursive: true });
  writeFileSync(successCasPath, successCasOriginal);
  chmodSync(successCasPath, 0o640);
  utimesSync(successCasPath, preservedMtime, preservedMtime);
  const successCasOriginalStats = statSync(successCasPath);
  const successCasWriter = runAsync(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${successCasPythonBin}${delimiter}${commandEnv.PATH}`,
    SUCCESS_CAS_CALLS: successCasCalls,
    SUCCESS_CAS_READY: successCasReady,
    SUCCESS_CAS_RELEASE: successCasRelease,
    XDG_CONFIG_HOME: successCasHome,
  });
  await waitForPath(successCasReady, "successful installed candidate validation pause");
  writeFileSync(successCasReplacementStage, successCasReplacement);
  chmodSync(successCasReplacementStage, 0o600);
  const successCasMtime = new Date("2025-04-05T06:07:08.000Z");
  utimesSync(successCasReplacementStage, successCasMtime, successCasMtime);
  const successCasReplacementStats = statSync(successCasReplacementStage);
  renameSync(successCasReplacementStage, successCasPath);
  writeFileSync(successCasRelease, "release\n");
  const successCasFailure = await successCasWriter.done;
  assert.notEqual(successCasFailure.status, 0);
  assert.match(successCasFailure.stderr, /Canonical Hermes config changed after successful candidate validation/);
  assert.match(successCasFailure.stderr, /canonical Hermes config was preserved/);
  assert.equal(readFileSync(successCasCalls, "utf8").trim(), "6", "successful validation conflict must not re-run the validator");
  assert.equal(readFileSync(successCasPath).equals(successCasReplacement), true);
  const successCasAfter = statSync(successCasPath);
  assert.equal(successCasAfter.dev, successCasReplacementStats.dev);
  assert.equal(successCasAfter.ino, successCasReplacementStats.ino);
  assert.equal(successCasAfter.mtimeMs, successCasReplacementStats.mtimeMs);
  assert.equal(successCasAfter.mode & 0o777, successCasReplacementStats.mode & 0o777);
  const successCasTransactions = readdirSync(successCasDirectory).filter((name) => name.startsWith(".pjangler-config-txn-"));
  assert.equal(successCasTransactions.length, 1);
  const successCasTransaction = join(successCasDirectory, successCasTransactions[0]);
  const successCasMarker = JSON.parse(readFileSync(join(successCasTransaction, "state.json"), "utf8"));
  assert.equal(successCasMarker.phase, "conflict");
  assert.equal(readFileSync(join(successCasTransaction, "operator-config")).equals(successCasOriginal), true);
  const successCasProtected = statSync(join(successCasTransaction, "operator-config"));
  assert.equal(successCasProtected.ino, successCasOriginalStats.ino);
  assert.equal(successCasProtected.nlink, 1);
  assert.equal(existsSync(join(successCasTransaction, "candidate.toml")), false);

  // Simulate process death after the candidate rename: the protected hard link
  // and prepared non-secret marker survive in the same directory. The next
  // invocation restores the original before validation, cleans the transaction,
  // then truthfully fails because this fixture intentionally has no python3.
  const staleHome = join(temp, "stale-transaction-xdg");
  const staleDirectory = join(staleHome, "hermes-agent-template");
  const stalePath = join(staleDirectory, "config.toml");
  const staleSource = Buffer.from("# stale crash original\n[fleet]\nhermes_bin = \"/operator/stale\"\n", "utf8");
  mkdirSync(staleDirectory, { recursive: true });
  writeFileSync(stalePath, staleSource);
  chmodSync(stalePath, 0o640);
  utimesSync(stalePath, preservedMtime, preservedMtime);
  const staleBefore = statSync(stalePath);
  // The stale marker deliberately names this test runner's live parent PID.
  // Kernel lock ownership proves the old transaction is inactive; numeric PID
  // reuse must not make recovery wait on an unrelated process.
  assert.doesNotThrow(() => process.kill(process.ppid, 0));
  const staleOwnerPid = process.ppid;
  const staleTransaction = join(staleDirectory, `.pjangler-config-txn-${staleOwnerPid}-dead01`);
  mkdirSync(staleTransaction, { mode: 0o700 });
  linkSync(stalePath, join(staleTransaction, "operator-config"));
  const staleCandidatePath = join(staleTransaction, "candidate.toml");
  const staleCandidate = Buffer.from("[fleet]\nhermes_bin = \"/unverified/candidate\"\n", "utf8");
  writeFileSync(staleCandidatePath, staleCandidate, { mode: 0o640 });
  const staleCandidateStats = statSync(staleCandidatePath);
  const identity = (stats, bytes) => ({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    hash: createHash("sha256").update(bytes).digest("hex"),
  });
  writeFileSync(join(staleTransaction, "state.json"), `${JSON.stringify({
    version: 1,
    ownerPid: staleOwnerPid,
    phase: "prepared",
    hadPrevious: true,
    candidate: identity(staleCandidateStats, staleCandidate),
    previous: identity(staleBefore, staleSource),
  })}\n`, { mode: 0o600 });
  renameSync(staleCandidatePath, stalePath);
  assert.notEqual(statSync(stalePath).ino, staleBefore.ino, "crash fixture must expose the unverified candidate before recovery");
  const staleRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: staleHome,
  });
  assert.notEqual(staleRecovery.status, 0);
  assert.match(staleRecovery.stderr, /python3 with tomllib is required but was not found/);
  assert.equal(readFileSync(stalePath).equals(staleSource), true);
  const staleAfter = statSync(stalePath);
  assert.equal(staleAfter.ino, staleBefore.ino);
  assert.equal(staleAfter.mtimeMs, staleBefore.mtimeMs);
  assert.equal(staleAfter.mode & 0o777, staleBefore.mode & 0o777);
  assert.equal(existsSync(staleTransaction), false, "automatic crash recovery must remove the protected transaction artifact");

  // Death immediately after mkdtemp/chmod leaves no candidate or marker. The
  // uniquely named, same-user empty transaction is safe to reap; malformed
  // non-empty state remains a hard failure rather than being guessed away.
  const emptyStaleTransaction = join(staleDirectory, ".pjangler-config-txn-99999998-empty01");
  mkdirSync(emptyStaleTransaction, { mode: 0o700 });
  const emptyStaleRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: staleHome,
  });
  assert.notEqual(emptyStaleRecovery.status, 0);
  assert.match(emptyStaleRecovery.stderr, /python3 with tomllib is required but was not found/);
  assert.equal(existsSync(emptyStaleTransaction), false, "an empty transaction left before candidate staging must be reaped");
  assert.equal(readFileSync(stalePath).equals(staleSource), true);
  assert.equal(statSync(stalePath).ino, staleBefore.ino);

  // Crash after EXCHANGE, either before verification or after verification but
  // before stagedPath unlink/phase=installed, has one exact topology:
  // canonical=candidate and stagedPath=operator-config=previous (nlink 2).
  // Recovery must atomically reverse it and restore the original automatically.
  const exactExchangeCrashHome = join(temp, "exact-install-exchange-crash-xdg");
  const exactExchangeCrashDirectory = join(exactExchangeCrashHome, "hermes-agent-template");
  const exactExchangeCrashPath = join(exactExchangeCrashDirectory, "config.toml");
  const exactExchangeCrashTransaction = join(exactExchangeCrashDirectory, ".pjangler-config-txn-99999995-exact01");
  const exactExchangeCandidate = Buffer.from("[fleet]\nhermes_bin = \"/transaction/exact-candidate\"\n", "utf8");
  const exactExchangeOriginal = Buffer.from("# exact pre-exchange original\n[fleet]\nhermes_bin = \"/operator/exact-original\"\n", "utf8");
  mkdirSync(exactExchangeCrashTransaction, { recursive: true, mode: 0o700 });
  writeFileSync(exactExchangeCrashPath, exactExchangeCandidate, { mode: 0o640 });
  const exactExchangeOperator = join(exactExchangeCrashTransaction, "operator-config");
  const exactExchangeStaged = join(exactExchangeCrashTransaction, "candidate.toml");
  writeFileSync(exactExchangeOperator, exactExchangeOriginal, { mode: 0o640 });
  utimesSync(exactExchangeOperator, preservedMtime, preservedMtime);
  linkSync(exactExchangeOperator, exactExchangeStaged);
  const exactExchangeCandidateStats = statSync(exactExchangeCrashPath);
  const exactExchangeOriginalStats = statSync(exactExchangeOperator);
  assert.equal(exactExchangeOriginalStats.nlink, 2);
  writeFileSync(join(exactExchangeCrashTransaction, "state.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 99999995,
    phase: "install-exchange",
    hadPrevious: true,
    candidate: identity(exactExchangeCandidateStats, exactExchangeCandidate),
    previous: identity(exactExchangeOriginalStats, exactExchangeOriginal),
  })}\n`, { mode: 0o600 });
  const exactExchangeRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: exactExchangeCrashHome,
  });
  assert.notEqual(exactExchangeRecovery.status, 0);
  assert.match(exactExchangeRecovery.stderr, /python3 with tomllib is required but was not found/);
  assert.equal(readFileSync(exactExchangeCrashPath).equals(exactExchangeOriginal), true);
  const exactExchangeRecovered = statSync(exactExchangeCrashPath);
  assert.equal(exactExchangeRecovered.ino, exactExchangeOriginalStats.ino);
  assert.equal(exactExchangeRecovered.mtimeMs, exactExchangeOriginalStats.mtimeMs);
  assert.equal(exactExchangeRecovered.mode & 0o777, exactExchangeOriginalStats.mode & 0o777);
  assert.equal(exactExchangeRecovered.nlink, 1);
  assert.equal(existsSync(exactExchangeCrashTransaction), false);

  // A third inode captured by the same crash boundary is not that topology.
  // Recovery must retain every entry, not mistake it for a disposable candidate.
  const exchangeCrashHome = join(temp, "install-exchange-crash-xdg");
  const exchangeCrashDirectory = join(exchangeCrashHome, "hermes-agent-template");
  const exchangeCrashPath = join(exchangeCrashDirectory, "config.toml");
  const exchangeCrashTransaction = join(exchangeCrashDirectory, ".pjangler-config-txn-99999997-xchg01");
  const exchangeCrashCandidate = Buffer.from("[fleet]\nhermes_bin = \"/transaction/candidate\"\n", "utf8");
  const exchangeCrashOriginal = Buffer.from("[fleet]\nhermes_bin = \"/operator/pre-exchange\"\n", "utf8");
  const exchangeCrashCaptured = Buffer.from("[fleet]\nhermes_bin = \"/operator/captured-external\"\n", "utf8");
  mkdirSync(exchangeCrashTransaction, { recursive: true, mode: 0o700 });
  writeFileSync(exchangeCrashPath, exchangeCrashCandidate, { mode: 0o640 });
  writeFileSync(join(exchangeCrashTransaction, "operator-config"), exchangeCrashOriginal, { mode: 0o640 });
  writeFileSync(join(exchangeCrashTransaction, "candidate.toml"), exchangeCrashCaptured, { mode: 0o600 });
  const exchangeCrashCandidateStats = statSync(exchangeCrashPath);
  const exchangeCrashOriginalStats = statSync(join(exchangeCrashTransaction, "operator-config"));
  const exchangeCrashCapturedStats = statSync(join(exchangeCrashTransaction, "candidate.toml"));
  writeFileSync(join(exchangeCrashTransaction, "state.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 99999997,
    phase: "install-exchange",
    hadPrevious: true,
    candidate: identity(exchangeCrashCandidateStats, exchangeCrashCandidate),
    previous: identity(exchangeCrashOriginalStats, exchangeCrashOriginal),
  })}\n`, { mode: 0o600 });
  const exchangeCrashRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: exchangeCrashHome,
  });
  assert.notEqual(exchangeCrashRecovery.status, 0);
  assert.match(exchangeCrashRecovery.stderr, /will not be removed|cannot be cleaned safely/);
  assert.equal(readFileSync(exchangeCrashPath).equals(exchangeCrashCandidate), true);
  assert.equal(readFileSync(join(exchangeCrashTransaction, "operator-config")).equals(exchangeCrashOriginal), true);
  assert.equal(readFileSync(join(exchangeCrashTransaction, "candidate.toml")).equals(exchangeCrashCaptured), true);
  assert.equal(statSync(join(exchangeCrashTransaction, "candidate.toml")).ino, exchangeCrashCapturedStats.ino);
  assert.equal(existsSync(exchangeCrashTransaction), true);

  // Crash after new-file rollback capture: stagedPath may contain a canonical
  // inode that raced the pre-read. Its identity differs from marker.candidate,
  // so recovery must fail unchanged and retain it for manual disposition.
  const captureCrashHome = join(temp, "rollback-capture-crash-xdg");
  const captureCrashDirectory = join(captureCrashHome, "hermes-agent-template");
  const captureCrashTransaction = join(captureCrashDirectory, ".pjangler-config-txn-99999996-capt01");
  const captureExpected = Buffer.from("[fleet]\nhermes_bin = \"/transaction/new-candidate\"\n", "utf8");
  const captureExternal = Buffer.from("[fleet]\nhermes_bin = \"/operator/captured-race\"\n", "utf8");
  mkdirSync(captureCrashTransaction, { recursive: true, mode: 0o700 });
  const captureIdentityPath = join(captureCrashDirectory, "identity-source.toml");
  writeFileSync(captureIdentityPath, captureExpected, { mode: 0o600 });
  const captureExpectedStats = statSync(captureIdentityPath);
  unlinkSync(captureIdentityPath);
  const captureCrashStaged = join(captureCrashTransaction, "candidate.toml");
  writeFileSync(captureCrashStaged, captureExternal, { mode: 0o600 });
  const captureExternalStats = statSync(captureCrashStaged);
  writeFileSync(join(captureCrashTransaction, "state.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 99999996,
    phase: "rollback-capture",
    hadPrevious: false,
    candidate: identity(captureExpectedStats, captureExpected),
  })}\n`, { mode: 0o600 });
  const captureCrashRecovery = run(["config", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: captureCrashHome,
  });
  assert.notEqual(captureCrashRecovery.status, 0);
  assert.match(captureCrashRecovery.stderr, /not this transaction's candidate and will not be removed/);
  assert.equal(readFileSync(captureCrashStaged).equals(captureExternal), true);
  const captureExternalAfter = statSync(captureCrashStaged);
  assert.equal(captureExternalAfter.ino, captureExternalStats.ino);
  assert.equal(captureExternalAfter.mtimeMs, captureExternalStats.mtimeMs);
  assert.equal(existsSync(captureCrashTransaction), true);
  assert.equal(existsSync(join(captureCrashDirectory, "config.toml")), false);

  // Forced config bootstrap is an additive schema upgrade. Operator values,
  // comments, unknown keys, and richer sections survive byte-for-byte.
  const configRepo = join(temp, "config-repo");
  const configHome = join(temp, "config-xdg");
  const configPath = join(configHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(configHome, "hermes-agent-template"), { recursive: true });
  mkdirSync(configRepo, { recursive: true });
  writeFileSync(configPath, `# precious operator comment\n[fleet]\nhermes_bin = "/operator/hermes"\ncustom_key = "keep"\n\n[operator]\nmode = "richer"\n`);
  const config = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: configHome,
  });
  assert.equal(config.status, 0, `${config.stdout}\n${config.stderr}`);
  assert.match(config.stdout, /Updated config without replacing existing values:/);
  assert.deepEqual(
    readdirSync(join(configHome, "hermes-agent-template")).filter((name) => name.startsWith(".pjangler-config-txn-")),
    [],
    "successful installation must remove every ephemeral transaction artifact",
  );
  const upgraded = readFileSync(configPath, "utf8");
  assert.match(upgraded, /# precious operator comment/);
  assert.match(upgraded, /hermes_bin = "\/operator\/hermes"/);
  assert.equal((upgraded.match(/^hermes_bin\s*=/gm) ?? []).length, 1, "existing schema values must not be duplicated");
  assert.match(upgraded, /custom_key = "keep"/);
  assert.match(upgraded, /\[operator\]\nmode = "richer"/);
  for (const key of ["pjangler_bin", "hermes_git_url", "hermes_git_ref", "hermes_git_sha", "oauth_file", "codex_home", "vox_plugin_name", "vox_plugin_dir", "vox_voice", "vox_url", "onepassword_vault", "onepassword_item_prefix"]) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `config upgrade should add ${key}`);
  }

  // Hold process A after its snapshot but before its first parse completes,
  // then launch process B against the same config. B must not reach even its
  // first validator until A releases the whole-window kernel lock. Afterwards
  // B re-snapshots A's installed file and reports an already-current schema.
  const lockPythonBin = join(temp, "lock-python-bin");
  const lockPython = join(lockPythonBin, "python3");
  const lockFirstOnce = join(temp, "lock-first-once");
  const lockFirstReady = join(temp, "lock-first-ready");
  const lockFirstRelease = join(temp, "lock-first-release");
  const lockSecondValidator = join(temp, "lock-second-validator");
  mkdirSync(lockPythonBin, { recursive: true });
  writeFileSync(lockPython, `#!/bin/sh
if [ "$LOCK_TEST_ROLE" = "first" ] && [ ! -e "$LOCK_TEST_FIRST_ONCE" ]; then
  : > "$LOCK_TEST_FIRST_ONCE"
  : > "$LOCK_TEST_FIRST_READY"
  while [ ! -e "$LOCK_TEST_FIRST_RELEASE" ]; do
    /bin/sleep 0.02
  done
fi
if [ "$LOCK_TEST_ROLE" = "second" ]; then
  : > "$LOCK_TEST_SECOND_VALIDATOR"
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(lockPython, 0o755);
  const lockHome = join(temp, "concurrent-config-xdg");
  const lockDirectory = join(lockHome, "hermes-agent-template");
  const lockConfigPath = join(lockDirectory, "config.toml");
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(lockConfigPath, "# concurrent operator config\n[fleet]\nhermes_bin = \"/operator/concurrent\"\n");
  const lockEnv = {
    ...commandEnv,
    PATH: `${lockPythonBin}${delimiter}${commandEnv.PATH}`,
    XDG_CONFIG_HOME: lockHome,
    LOCK_TEST_FIRST_ONCE: lockFirstOnce,
    LOCK_TEST_FIRST_READY: lockFirstReady,
    LOCK_TEST_FIRST_RELEASE: lockFirstRelease,
    LOCK_TEST_SECOND_VALIDATOR: lockSecondValidator,
  };
  const firstWriter = runAsync(["config", "bootstrap", "--force"], configRepo, {
    ...lockEnv,
    LOCK_TEST_ROLE: "first",
  });
  await waitForPath(lockFirstReady, "first writer validator pause");
  const secondWriter = runAsync(["config", "bootstrap", "--force"], configRepo, {
    ...lockEnv,
    LOCK_TEST_ROLE: "second",
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  assert.equal(secondWriter.child.exitCode, null, "second writer must remain blocked while the first owns the config lock");
  assert.equal(existsSync(lockSecondValidator), false, "second writer must not validate or snapshot stale config while waiting");
  writeFileSync(lockFirstRelease, "release\n");
  const [firstWriterResult, secondWriterResult] = await Promise.all([firstWriter.done, secondWriter.done]);
  assert.equal(firstWriterResult.status, 0, `${firstWriterResult.stdout}\n${firstWriterResult.stderr}`);
  assert.equal(secondWriterResult.status, 0, `${secondWriterResult.stdout}\n${secondWriterResult.stderr}`);
  assert.match(firstWriterResult.stdout, /Updated config without replacing existing values:/);
  assert.match(secondWriterResult.stdout, /Config schema already current:/);
  assert.equal(existsSync(lockSecondValidator), true, "second writer should proceed after acquiring the released lock");
  const serializedConfig = readFileSync(lockConfigPath, "utf8");
  assert.equal((serializedConfig.match(/^hermes_bin\s*=/gm) ?? []).length, 1);
  assert.match(serializedConfig, /^pjangler_bin\s*=/m);
  const durableLock = lstatSync(join(lockDirectory, ".pjangler-config.lock"));
  assert.equal(durableLock.isFile(), true);
  assert.equal(durableLock.nlink, 1);
  assert.equal(durableLock.size, 0);
  assert.equal(durableLock.mode & 0o077, 0);

  // The lock leaf itself is never followed. Both live and dangling symlinks
  // fail before config creation and cannot redirect flock to an attacker leaf.
  for (const kind of ["live", "dangling"]) {
    const unsafeLockHome = join(temp, `unsafe-${kind}-lock-xdg`);
    const unsafeLockDirectory = join(unsafeLockHome, "hermes-agent-template");
    const unsafeLockConfig = join(unsafeLockDirectory, "config.toml");
    const unsafeLockTarget = join(temp, `unsafe-${kind}-lock-target`);
    mkdirSync(unsafeLockDirectory, { recursive: true });
    if (kind === "live") writeFileSync(unsafeLockTarget, "operator sentinel\n");
    symlinkSync(unsafeLockTarget, join(unsafeLockDirectory, ".pjangler-config.lock"));
    const unsafeLock = run(["config", "bootstrap", "--force"], configRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: unsafeLockHome,
    });
    assert.notEqual(unsafeLock.status, 0);
    assert.match(unsafeLock.stderr, /Failed to acquire the whole-window Hermes config lock/);
    assert.match(unsafeLock.stderr, /expected a regular non-symlink file/);
    assert.equal(existsSync(unsafeLockConfig), false);
    if (kind === "live") assert.equal(readFileSync(unsafeLockTarget, "utf8"), "operator sentinel\n");
  }

  // If the canonical lock pathname is replaced while this process waits, its
  // inherited O_NOFOLLOW descriptor still references the old inode. Refuse
  // before config mutation instead of silently splitting writers across two
  // lock domains.
  const swappedLockHome = join(temp, "swapped-lock-xdg");
  const swappedLockDirectory = join(swappedLockHome, "hermes-agent-template");
  const swappedLockPath = join(swappedLockDirectory, ".pjangler-config.lock");
  const swappedConfigPath = join(swappedLockDirectory, "config.toml");
  const displacedLockPath = join(swappedLockDirectory, ".displaced-pjangler-lock");
  const blockerReady = join(temp, "swapped-lock-blocker-ready");
  const blockerRelease = join(temp, "swapped-lock-blocker-release");
  mkdirSync(swappedLockDirectory, { recursive: true });
  writeFileSync(swappedLockPath, "", { mode: 0o600 });
  const blocker = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      swappedLockPath,
      "/bin/sh",
      "-c",
      ': > "$LOCK_BLOCKER_READY"; while [ ! -e "$LOCK_BLOCKER_RELEASE" ]; do /bin/sleep 0.02; done',
    ],
    {
      env: {
        ...process.env,
        LOCK_BLOCKER_READY: blockerReady,
        LOCK_BLOCKER_RELEASE: blockerRelease,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let blockerStderr = "";
  blocker.stderr.setEncoding("utf8");
  blocker.stderr.on("data", (chunk) => { blockerStderr += chunk; });
  const blockerDone = new Promise((resolveBlocker, rejectBlocker) => {
    blocker.once("error", rejectBlocker);
    blocker.once("close", (status, signal) => {
      if (status === 0) resolveBlocker();
      else rejectBlocker(new Error(`lock blocker failed (status=${status}, signal=${signal}): ${blockerStderr}`));
    });
  });
  await waitForPath(blockerReady, "external lock blocker");
  const swappedWriter = runAsync(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: swappedLockHome,
  });
  await waitForChildCommand(swappedWriter.child.pid, "flock");
  const openedLockInode = statSync(swappedLockPath).ino;
  renameSync(swappedLockPath, displacedLockPath);
  writeFileSync(swappedLockPath, "", { mode: 0o600 });
  assert.notEqual(statSync(swappedLockPath).ino, openedLockInode);
  writeFileSync(blockerRelease, "release\n");
  await blockerDone;
  const swappedWriterResult = await swappedWriter.done;
  assert.notEqual(swappedWriterResult.status, 0);
  assert.match(swappedWriterResult.stderr, /Failed to acquire the whole-window Hermes config lock/);
  assert.match(swappedWriterResult.stderr, /changed identity or safety properties during acquisition/);
  assert.equal(existsSync(swappedConfigPath), false, "a split-domain lock must fail before config creation");
  const afterSwap = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: swappedLockHome,
  });
  assert.equal(afterSwap.status, 0, `${afterSwap.stdout}\n${afterSwap.stderr}`);
  assert.match(afterSwap.stdout, /Bootstrapped config without replacing existing values:/);
  assert.equal(statSync(swappedLockPath).ino === openedLockInode, false);

  const committedTemplate = committedHermesTemplate("template/.scripts/config.example.toml");
  assert.match(committedTemplate.gitlink, /^[0-9a-f]{40}$/);
  const templateConfig = committedTemplate.content;
  for (const [, key] of templateConfig.matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `parent bootstrap must cover pinned template key ${key}`);
  }
  assert.doesNotMatch(
    upgraded,
    /^pm_external_skill_dirs\s*=|^voxxy_plugin_dir\s*=|^\[bloodbank\]/m,
    "retired config schema must not be reintroduced",
  );

  // Final template lifecycle contracts are read from the parent commit's
  // gitlink object, never from templates/hermes-agent's mutable checkout.
  const copierContract = committedHermesTemplate("copier.yml").content;
  const roleContract = committedHermesTemplate("template/role.yaml.jinja").content;
  const telegramContract = committedHermesTemplate("template/.scripts/30-telegram.sh").content;
  const slackContract = committedHermesTemplate("template/.scripts/31-slack.sh").content;
  const libraryContract = committedHermesTemplate("template/.scripts/_lib.sh").content;
  const runtimeContract = committedHermesTemplate("template/.scripts/20-runtime-repo.sh").content;
  assert.match(copierContract, /reconcile_enabled:\n[\s\S]*?default: true/);
  assert.match(copierContract, /_skip_if_exists:[\s\S]*?\n\s+- role\.yaml/);
  assert.match(roleContract, /telegram:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /slack:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /reconcile:[\s\S]*?explicit_opt_out:/);
  assert.match(roleContract, /bloodbank:\n[\s\S]*?\n\s+enabled: false/);
  assert.match(roleContract, /service_state:\n\s+gateway: "pending"\n\s+heartbeat: "pending"/);
  assert.match(
    telegramContract,
    /if \[\[ "\$\{SKIP_TELEGRAM:-0\}" == "1" \]\]; then[\s\S]*?profile_channel_enabled_set "\$PROFILE_HOME" telegram false[\s\S]*?telegram_yaml_update provisioning_status deferred/,
    "deferred Telegram must write platforms.telegram.enabled=false explicitly",
  );
  assert.match(
    slackContract,
    /if \[\[ "\$\{SKIP_SLACK:-0\}" == "1" \]\]; then[\s\S]*?profile_channel_enabled_set "\$PROFILE_HOME" slack false[\s\S]*?slack_yaml_update provisioning_status deferred/,
    "deferred Slack must write platforms.slack.enabled=false explicitly",
  );
  assert.match(libraryContract, /elif mode == "channel-enabled":[\s\S]*?channel\["enabled"\] = value == "true"/);
  assert.match(runtimeContract, /pure-local Hermes runtime without creating a Git/);
  assert.match(runtimeContract, /RUNTIME_LOCAL="\$ROLE_DIR\/runtime"/);
  assert.doesNotMatch(runtimeContract, /gh\s+repo\s+create|git\s+init|git\s+push|git\s+submodule\s+add/);

  // Inline comments are part of a valid TOML table header. The merge must
  // recognize that exact owner instead of appending a duplicate [fleet].
  const inlineHome = join(temp, "inline-xdg");
  const inlinePath = join(inlineHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(inlineHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(inlinePath, `[fleet] # keep this operator comment\nhermes_bin = "/operator/hermes"\n\n[operator]\nmode = "richer"\n`);
  const inline = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: inlineHome,
  });
  assert.equal(inline.status, 0, `${inline.stdout}\n${inline.stderr}`);
  const inlineMerged = readFileSync(inlinePath, "utf8");
  assert.equal((inlineMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);
  assert.match(inlineMerged, /^\[fleet\] # keep this operator comment$/m);
  assert.equal((inlineMerged.match(/^hermes_bin\s*=/gm) ?? []).length, 1);

  // A normal table owns keys only until the next table header, including an
  // array-table header. Missing [fleet] keys must stay out of [[fleet.plugins]].
  const arrayHome = join(temp, "array-xdg");
  const arrayPath = join(arrayHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(arrayHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(arrayPath, `[fleet] # owner\nhermes_bin = "/operator/hermes"\n\n[[fleet.plugins]] # child array\nname = "operator-plugin"\n\n[operator]\nmode = "richer"\n`);
  const array = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: arrayHome,
  });
  assert.equal(array.status, 0, `${array.stdout}\n${array.stderr}`);
  const arrayMerged = readFileSync(arrayPath, "utf8");
  const fleetStart = arrayMerged.indexOf("[fleet] # owner");
  const pluginStart = arrayMerged.indexOf("[[fleet.plugins]] # child array");
  const operatorStart = arrayMerged.indexOf("[operator]");
  assert.ok(fleetStart !== -1 && fleetStart < pluginStart && pluginStart < operatorStart);
  assert.match(arrayMerged.slice(fleetStart, pluginStart), /^pjangler_bin\s*=/m);
  assert.doesNotMatch(arrayMerged.slice(pluginStart, operatorStart), /^pjangler_bin\s*=/m);
  assert.equal((arrayMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);

  // An array table cannot be silently reinterpreted as the scalar [fleet]
  // owner. Fail closed and preserve the source exactly.
  const incompatibleHome = join(temp, "incompatible-xdg");
  const incompatiblePath = join(incompatibleHome, "hermes-agent-template", "config.toml");
  const incompatibleSource = `[[fleet]] # intentionally incompatible\nname = "entry"\n`;
  mkdirSync(join(incompatibleHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(incompatiblePath, incompatibleSource);
  const incompatible = run(["config", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: incompatibleHome,
  });
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Cannot merge \[fleet\].*array table/);
  assert.equal(readFileSync(incompatiblePath, "utf8"), incompatibleSource);

  // Valid TOML can express fleet ownership through root dotted keys, dotted
  // keys inside [fleet], or an inline table. A preservation-safe additive
  // upgrade cannot turn any of these into a scalar without redefining a table,
  // so fail unchanged instead of writing invalid TOML and claiming success.
  for (const [label, source] of [
    ["root-dotted", `fleet.hermes_bin = "/operator/hermes" # keep dotted form\n`],
    ["table-dotted", `[fleet] # keep owner\nhermes_bin.path = "/operator/hermes"\n`],
    ["inline-table", `fleet = { hermes_bin = "/operator/hermes", custom = "keep" } # immutable inline table\n`],
  ]) {
    const unsafeHome = join(temp, `${label}-xdg`);
    const unsafePath = join(unsafeHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(unsafeHome, "hermes-agent-template"), { recursive: true });
    writeFileSync(unsafePath, source);
    const before = statSync(unsafePath);
    const unsafe = run(["config", "bootstrap", "--force"], configRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: unsafeHome,
    });
    assert.notEqual(unsafe.status, 0, `${label} must fail closed`);
    assert.match(unsafe.stderr, /Merged Hermes template config is not valid TOML/);
    assert.doesNotMatch(unsafe.stdout, /Updated|Bootstrapped/);
    assert.equal(readFileSync(unsafePath, "utf8"), source, `${label} failure must preserve exact bytes`);
    const after = statSync(unsafePath);
    assert.equal(after.ino, before.ino, `${label} failure must not replace the file`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${label} failure must not write the file`);
  }

  // Stateful systemctl fixture: action exit 0 is not enough; parity must probe
  // the resulting enabled/active leaves before recording durable state.
  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, `#!/usr/bin/env sh
state_dir="\${PJAN86_SYSTEMD_STATE:?}"
mkdir -p "$state_dir"
command_name="\${2:-}"
case "$command_name" in
  is-system-running|daemon-reload) exit 0 ;;
  enable)
    unit="\${4:-}"
    if [ "\${PJAN86_HEARTBEAT_VERIFY_FAIL:-}" = "1" ] && printf '%s' "$unit" | grep -q heartbeat; then
      exit 0
    fi
    : > "$state_dir/$unit.enabled"
    : > "$state_dir/$unit.active"
    exit 0
    ;;
  disable)
    unit="\${4:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" != "1" ]; then
      rm -f -- "$state_dir/$unit.enabled" "$state_dir/$unit.active"
    fi
    exit 0
    ;;
  is-enabled)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.enabled" ] && exit 0 || exit 1
    ;;
  is-active)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.active" ] && exit 0 || exit 1
    ;;
esac
exit 1
`);
  chmodSync(fakeSystemctl, 0o755);

  // systemd parity evaluates heartbeat and gateway independently: an active
  // heartbeat plus deferred gateway is healthy only while the gateway is
  // disabled and inactive.
  const parityRepo = join(temp, "parity-repo");
  const parityHome = join(temp, "parity-home");
  const parityRole = join(parityRepo, "agents", "hermes", "pm");
  const systemdDir = join(parityHome, ".config", "systemd", "user");
  const parityState = join(temp, "parity-systemd-state");
  mkdirSync(parityRole, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  mkdirSync(parityState, { recursive: true });
  writeFileSync(join(parityRole, "role.yaml"), `repo: parity-repo\nrole: pm\nagent_id: parity-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: active\n`);
  const parityGateway = "hermes-parity-repo-pm-gateway.service";
  const parityHeartbeat = "hermes-parity-repo-pm-heartbeat.timer";
  for (const unit of [parityGateway, parityHeartbeat]) {
    writeFileSync(join(systemdDir, unit), "[Unit]\nDescription=fixture\n");
  }
  writeFileSync(join(parityState, `${parityHeartbeat}.enabled`), "");
  writeFileSync(join(parityState, `${parityHeartbeat}.active`), "");
  for (const probe of ["is-enabled", "is-active"]) {
    const fixtureProbe = spawnSync(fakeSystemctl, ["--user", probe, parityHeartbeat], {
      encoding: "utf8",
      env: { ...process.env, PJAN86_SYSTEMD_STATE: parityState },
    });
    assert.equal(fixtureProbe.status, 0, `systemctl fixture ${probe} failed: ${fixtureProbe.stderr}`);
  }
  const deferredAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
  });
  const deferredFinding = JSON.parse(deferredAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(deferredFinding.status, "pass", JSON.stringify(deferredFinding));
  const unsafeAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  const unsafeFinding = JSON.parse(unsafeAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(unsafeFinding.status, "fail");
  assert.match(unsafeFinding.details.join("\n"), /deferred and should be disabled\+inactive/);

  // installed -> active becomes durable only after enable + active probes.
  // The deferred gateway remains deferred, and the immediate post-audit passes.
  const migrateRepo = join(temp, "migrate-repo");
  const migrateHome = join(temp, "migrate-home");
  const migrateRole = join(migrateRepo, "agents", "hermes", "pm");
  const migrateSystemd = join(migrateHome, ".config", "systemd", "user");
  const migrateState = join(temp, "migrate-systemd-state");
  const migrateRolePath = join(migrateRole, "role.yaml");
  mkdirSync(migrateRole, { recursive: true });
  mkdirSync(migrateSystemd, { recursive: true });
  mkdirSync(migrateState, { recursive: true });
  const migrateRoleSource = `# preserve role comment\nrepo: migrate-repo\nrole: pm\nagent_id: migrate-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(migrateRolePath, migrateRoleSource);
  for (const unit of ["hermes-migrate-repo-pm-gateway.service", "hermes-migrate-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(migrateSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const migrated = run(["migrate", "systemd.sentinel", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  const migratedReport = JSON.parse(migrated.stdout);
  const migratedResult = migratedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(migratedResult.status, "applied", JSON.stringify(migratedResult));
  assert.ok(migratedResult.changedFiles.includes(migrateRolePath));
  const migratedRole = readFileSync(migrateRolePath, "utf8");
  assert.match(migratedRole, /^# preserve role comment$/m);
  assert.match(migratedRole, /service_state:\n\s+gateway: deferred\n\s+heartbeat: active/);
  const migratedAudit = run(["audit", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  const migratedFinding = JSON.parse(migratedAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(migratedFinding.status, "pass", JSON.stringify(migratedFinding));

  // A successful disable command followed by a still-active deferred gateway
  // is a failed postcondition. role.yaml must remain byte-identical.
  const failureRepo = join(temp, "failure-repo");
  const failureHome = join(temp, "failure-home");
  const failureRole = join(failureRepo, "agents", "hermes", "pm");
  const failureSystemd = join(failureHome, ".config", "systemd", "user");
  const failureState = join(temp, "failure-systemd-state");
  const failureRolePath = join(failureRole, "role.yaml");
  mkdirSync(failureRole, { recursive: true });
  mkdirSync(failureSystemd, { recursive: true });
  mkdirSync(failureState, { recursive: true });
  const failureRoleSource = `repo: failure-repo\nrole: pm\nagent_id: failure-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(failureRolePath, failureRoleSource);
  for (const unit of ["hermes-failure-repo-pm-gateway.service", "hermes-failure-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(failureSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const failedMigration = run(["migrate", "systemd.sentinel", failureRepo, "--json"], failureRepo, {
    ...commandEnv,
    HOME: failureHome,
    PJAN86_SYSTEMD_STATE: failureState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  assert.notEqual(failedMigration.status, 0);
  const failedReport = JSON.parse(failedMigration.stdout);
  const failedResult = failedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(failedResult.status, "blocked", JSON.stringify(failedResult));
  assert.match(failedResult.details.join("\n"), /did not become disabled\+inactive/);
  assert.equal(readFileSync(failureRolePath, "utf8"), failureRoleSource);

  // Source-level orchestration tripwires complement the process tests: summary
  // is final-only and explicit --force is the sole overwrite path.
  const recipe = readFileSync(join(root, "src", "recipes", "HermesAgentRecipe.ts"), "utf8");
  const copier = readFileSync(join(root, "src", "commands", "hermes", "RunCopierTemplate.ts"), "utf8");
  const configBootstrap = readFileSync(join(root, "src", "commands", "hermes", "EnsureTemplateConfig.ts"), "utf8");
  const optionValidation = readFileSync(join(root, "src", "commands", "hermes", "ValidateHermesOptions.ts"), "utf8");
  const externalEffects = readFileSync(join(root, "src", "commands", "hermes", "ApplyDeferredExternalEffects.ts"), "utf8");
  const mcpServer = readFileSync(join(root, "src", "mcp-server.ts"), "utf8");
  const summary = readFileSync(join(root, "src", "commands", "hermes", "PrintHermesSummary.ts"), "utf8");
  const ingredients = recipe.match(/const ingredients = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.doesNotMatch(ingredients, /PrintHermesSummary/, "summary must not run before lifecycle postconditions");
  assert.ok(recipe.indexOf("ValidateHermesOptions") < recipe.indexOf("EnsureTemplateConfig", recipe.indexOf("const ingredients")));
  assert.match(copier, /if \(ctx\.force\) args\.push\("--overwrite"\)/);
  assert.match(copier, /if \(ctx\.yes \|\| ctx\.quiet\) args\.push\("--defaults"\)/);
  assert.doesNotMatch(copier, /ctx\.yes\)\s*\{\s*ctx\.force\s*=\s*true/);
  assert.match(configBootstrap, /spawnSync\("python3", \["-I", "-S", "-c", TOMLLIB_VALIDATE\]/);
  assert.match(configBootstrap, /!name\.toUpperCase\(\)\.startsWith\("PYTHON"\)/);
  assert.match(configBootstrap, /timeout: TOMLLIB_VALIDATION_TIMEOUT_MS/);
  assert.match(configBootstrap, /killSignal: "SIGKILL"/);
  assert.match(configBootstrap, /tomllib\.loads\(source\)/);
  assert.doesNotMatch(configBootstrap, /smol-toml|parse as parseToml/);
  assert.match(configBootstrap, /constants\.O_NOFOLLOW/);
  assert.match(configBootstrap, /"\/usr\/bin\/flock"/);
  assert.match(configBootstrap, /"\/proc\/self\/fd\/3"/);
  assert.match(configBootstrap, /current\.dev !== lock\.identity\.dev/);
  assert.match(configBootstrap, /current\.ino !== lock\.identity\.ino/);
  assert.doesNotMatch(configBootstrap, /processIsAlive|process\.kill\(pid, 0\)/);
  assert.ok(configBootstrap.indexOf("pathStats = inspectConfigPath(path)") < configBootstrap.indexOf("if (exists && !force)"));
  assert.match(configBootstrap, /PJANGLER_RENAMEAT2_HELPER/);
  assert.match(configBootstrap, /trustedAtomicRenamePython\(\)/);
  assert.match(configBootstrap, /stdio: \["ignore", "pipe", "pipe", directory\.descriptor\]/);
  assert.match(configBootstrap, /atomicRenameAt2\(path, stagedRelative, configRelative, "exchange"\)/);
  assert.match(configBootstrap, /atomicRenameAt2\(path, stagedRelative, configRelative, "noreplace"\)/);
  assert.doesNotMatch(configBootstrap, /renameSync\(stagedPath, path\)|renameSync\(operatorPath, path\)/);
  assert.match(configBootstrap, /assertValidTomlBytes\(written\.bytes, "Installed Hermes template config"\)/);
  assert.match(configBootstrap, /assertSnapshotIdentity\(current, previous/);
  assert.match(configBootstrap, /assertLinkCount\(previous, 1, `Existing Hermes template config/);
  assert.match(configBootstrap, /linkSync\(path, operatorPath\)/);
  assert.match(configBootstrap, /assertLinkCount\(linkedCanonical, 2/);
  assert.match(configBootstrap, /assertLinkCount\(protectedOriginal, 2/);
  assert.ok(
    configBootstrap.indexOf("Canonical Hermes config before rollback intent") < configBootstrap.lastIndexOf('atomicRenameAt2(path, operatorRelative, configRelative, "exchange")'),
    "live rollback must pre-read the candidate before its atomic exchange",
  );
  assert.match(configBootstrap, /phase: "install-exchange"/);
  assert.match(configBootstrap, /phase: "rollback-exchange"/);
  assert.match(configBootstrap, /phase: "rollback-capture"/);
  assert.match(configBootstrap, /phase: "conflict"/);
  assert.match(configBootstrap, /retained for manual recovery/);
  assert.ok(
    configBootstrap.lastIndexOf('atomicRenameAt2(path, operatorRelative, configRelative, "exchange")') < configBootstrap.indexOf('assertValidTomlBytes(restored.bytes, "Post-restore Hermes template config")'),
    "the original inode must be restored before any post-restore validator call",
  );
  assert.ok(
    configBootstrap.indexOf('phase: "committed"') < configBootstrap.indexOf("Canonical Hermes config before releasing protected state") &&
      configBootstrap.indexOf("Canonical Hermes config before releasing protected state") < configBootstrap.indexOf("unlinkSync(operatorPath)", configBootstrap.indexOf("Canonical Hermes config before releasing protected state")),
    "success must journal committed intent, re-read the live candidate, then release the protected original",
  );
  assert.doesNotMatch(configBootstrap, /assertValidTomlBytes\(previous\.bytes, "Rollback/);
  assert.match(configBootstrap, /recoverInterruptedConfigTransactions\(path, !ctx\.dryRun\)/);
  assert.match(optionValidation, /const stats = lstatSync\(path\)/);
  assert.match(optionValidation, /!stats\.isFile\(\)/);
  assert.match(optionValidation, /stats\.nlink !== 1/);
  assert.doesNotMatch(externalEffects, /20-runtime-repo\.sh|selected\.runtimeRepo/);
  assert.match(mcpServer, /Deprecated no-op\. Hermes always converges ignored role-local runtime state/);
  assert.doesNotMatch(mcpServer, /runtimeRepo:\s*externalEffects|externalEffects\.runtimeRepo/);
  assert.doesNotMatch(summary, /@clack\/prompts|Provisioned|\bDone\.|runtime\s+gh:/);
} finally {
  if (openSocketServer) {
    await new Promise((resolveClose) => openSocketServer.close(() => resolveClose()));
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log("PJAN-86 Hermes deploy regressions: PASS");
