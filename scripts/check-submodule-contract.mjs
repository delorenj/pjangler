#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SUPPORTED = new Map([
  ["templates/commonproject", { url: "git@github.com:delorenj/CommonProject.git", branch: "main" }],
  ["templates/hermes-agent", { url: "git@github.com:delorenj/hermes-agent-template.git", branch: "main" }],
]);
const FORBIDDEN_TRACKED = [
  { pattern: /^\.tmp(?:\/|$)/, label: "host-local .tmp cache" },
  { pattern: /^memories(?:\/|$)/, label: "host-local memories" },
  { pattern: /^agents\/hermes\/[^/]+\/runtime(?:\/|$)/, label: "Hermes local runtime" },
];

function fail(message) {
  process.stderr.write(`submodule-contract: ${message}\n`);
  process.exitCode = 1;
}

function run(root, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function trackedEntries(root) {
  const result = run(root, "git", ["ls-files", "--stage", "-z"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return result.stdout.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d{6}) ([0-9a-f]{40}) (\d)\t([\s\S]+)$/);
    if (!match) throw new Error(`unparseable index entry: ${JSON.stringify(entry)}`);
    return { mode: match[1], sha: match[2], stage: Number(match[3]), path: match[4] };
  });
}

function parseGitmodules(root) {
  const text = readFileSync(resolve(root, ".gitmodules"), "utf8");
  const records = [];
  let current = null;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const section = rawLine.match(/^\[submodule "([^"\n]+)"\]\s*$/);
    if (section) {
      current = { name: section[1], line: index + 1 };
      records.push(current);
      continue;
    }
    const field = rawLine.match(/^\s*(path|url|branch)\s*=\s*(.+?)\s*$/);
    if (field && current) current[field[1]] = field[2];
    if (rawLine.trim() && !rawLine.trim().startsWith("#") && !section && !field) {
      throw new Error(`unsupported .gitmodules syntax on line ${index + 1}`);
    }
  }
  return records;
}

function validateMetadata(root, entries) {
  const gitlinks = new Map(entries.filter((entry) => entry.mode === "160000").map((entry) => [entry.path, entry]));
  const records = parseGitmodules(root);
  const mapped = new Map();
  for (const record of records) {
    if (!record.path || !record.url || !record.branch) {
      fail(`mapping ${record.name} must declare path, url, and branch`);
      continue;
    }
    if (mapped.has(record.path)) fail(`duplicate mapping for ${record.path}`);
    mapped.set(record.path, record);
  }

  for (const path of gitlinks.keys()) if (!mapped.has(path)) fail(`orphan gitlink: ${path}`);
  for (const path of mapped.keys()) if (!gitlinks.has(path)) fail(`stale .gitmodules mapping: ${path}`);
  for (const path of SUPPORTED.keys()) {
    if (!gitlinks.has(path)) fail(`supported gitlink missing: ${path}`);
    if (!mapped.has(path)) fail(`supported mapping missing: ${path}`);
  }
  for (const path of gitlinks.keys()) if (!SUPPORTED.has(path)) fail(`unsupported gitlink: ${path}`);
  for (const path of mapped.keys()) if (!SUPPORTED.has(path)) fail(`unsupported mapping: ${path}`);

  for (const [path, expected] of SUPPORTED) {
    const record = mapped.get(path);
    if (!record) continue;
    if (record.url !== expected.url) fail(`${path} URL must be ${expected.url}`);
    if (record.branch !== expected.branch) fail(`${path} branch must be ${expected.branch}`);
  }

  for (const entry of entries) {
    const forbidden = FORBIDDEN_TRACKED.find(({ pattern }) => pattern.test(entry.path));
    if (forbidden) fail(`${forbidden.label} must not be tracked: ${entry.path}`);
  }
  return { gitlinks, mapped };
}

function validateRemote(root, contract) {
  for (const [path, expected] of SUPPORTED) {
    const pin = contract.gitlinks.get(path)?.sha;
    const result = run(root, "git", ["ls-remote", "--exit-code", expected.url, `refs/heads/${expected.branch}`]);
    if (result.status !== 0) {
      fail(`${path} remote branch is unreachable`);
      continue;
    }
    const remoteSha = result.stdout.trim().split(/\s+/)[0];
    if (remoteSha !== pin) fail(`${path} pin ${pin} is not published at ${expected.branch} (${remoteSha})`);
  }
}

function validateRecursive(root) {
  const result = run(root, "git", ["submodule", "status", "--recursive"]);
  if (result.status !== 0) return fail(result.stderr.trim() || "recursive submodule status failed");
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (/^[-+U]/.test(line)) fail(`submodule is not initialized at its exact pin: ${line.slice(0, 120)}`);
  }
}

function assertNoForbiddenPayload(paths, surface) {
  for (const path of paths) {
    const normalized = path.replace(/^package\//, "").replace(/\/$/, "");
    const forbidden = FORBIDDEN_TRACKED.find(({ pattern }) => pattern.test(normalized));
    if (forbidden) fail(`${surface} contains ${forbidden.label}: ${path}`);
  }
}

function validateArchive(root) {
  const archive = run(root, "git", ["archive", "--format=tar", "HEAD"], { encoding: null });
  if (archive.status !== 0) return fail(archive.stderr?.toString().trim() || "git archive failed");
  const listing = run(root, "tar", ["-tf", "-"], { input: archive.stdout });
  if (listing.status !== 0) return fail(listing.stderr.trim() || "tar listing failed");
  assertNoForbiddenPayload(listing.stdout.split(/\r?\n/).filter(Boolean), "git archive");
}

function validateNpm(root) {
  const result = run(root, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  if (result.status !== 0) return fail(result.stderr.trim() || "npm pack dry-run failed");
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return fail("npm pack dry-run returned invalid JSON");
  }
  const packRecord = Array.isArray(payload) ? payload[0] : Object.values(payload ?? {})[0];
  const files = packRecord?.files?.map((entry) => entry.path) ?? [];
  assertNoForbiddenPayload(files, "npm package");
  for (const required of ["templates/commonproject/copier.yml", "templates/hermes-agent/copier.yml"]) {
    if (!files.includes(required)) fail(`npm package is missing populated ${required}`);
  }
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd());
try {
  const entries = trackedEntries(root);
  const contract = validateMetadata(root, entries);
  if (args.includes("--remote")) validateRemote(root, contract);
  if (args.includes("--recursive")) validateRecursive(root);
  if (args.includes("--archive")) validateArchive(root);
  if (args.includes("--npm")) validateNpm(root);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!process.exitCode) process.stdout.write("submodule-contract: verified\n");
