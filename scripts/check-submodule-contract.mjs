#!/usr/bin/env node

import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const HERMES_TEMPLATE_MANIFEST = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "..", "hermes-template-assets.json"), "utf8"),
);

const SUPPORTED = new Map([
  ["templates/commonproject", { url: "git@github.com:delorenj/CommonProject.git", branch: "main" }],
  ["templates/hermes-agent", { url: "git@github.com:delorenj/hermes-agent-template.git", branch: "main" }],
]);
const FORBIDDEN_TRACKED = [
  { pattern: /^\.tmp(?:\/|$)/, label: "host-local .tmp cache" },
  { pattern: /^memories(?:\/|$)/, label: "host-local memories" },
  { pattern: /^agents\/hermes\/[^/]+\/runtime(?:\/|$)/, label: "Hermes local runtime" },
  {
    pattern: /(?:^|\/)\.codegraph\/(?:daemon\.pid|[^/]+\.(?:pid|sock|socket))(?:$|\/)/,
    label: "CodeGraph daemon runtime state",
  },
  {
    pattern: /(?:^|\/)\.omo\/run-continuation(?:\/|$)/,
    label: "Omo run-continuation state",
  },
  {
    pattern: /(?:^|\/)(?:run|runtime|tmp|temp|cache|\.cache)\/[^/]+\.(?:pid|sock|socket)$/,
    label: "process or socket runtime state",
  },
];
const REQUIRED_HERMES_PACKAGE_ASSETS = Object.entries(HERMES_TEMPLATE_MANIFEST.files).map(
  ([submodulePath, identity]) => ({
    packagePath: `templates/hermes-agent/${submodulePath}`,
    submodulePath,
    identity,
  }),
);

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

// `git submodule status` reports ONLY whether the checked-out commit matches the
// gitlink recorded in the parent index. A submodule whose working tree carries
// uncommitted edits or untracked files still reports a clean " " flag, because
// those changes exist in no commit at all. That gap is exactly how a template
// change can look shipped locally while `git archive HEAD` — i.e. every fresh
// clone, and the tarball `npm publish` builds from the pin — still contains the
// old tree. Enumerate each submodule and demand a genuinely clean worktree.
function submodulePaths(root) {
  const result = run(root, "git", ["submodule", "status", "--recursive"]);
  if (result.status !== 0) {
    fail(result.stderr.trim() || "recursive submodule status failed");
    return null;
  }
  const paths = [];
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (/^[-+U]/.test(line)) fail(`submodule is not initialized at its exact pin: ${line.slice(0, 120)}`);
    // `<flag><sha1> <path>[ (<describe>)]`. The describe suffix is absent for
    // uninitialized entries, so strip it only when the line actually ends in ")".
    const match = line.match(/^[ +\-U][0-9a-f]{40} (.+?)(?: \([^)]*\))?$/);
    if (!match) {
      fail(`unparseable submodule status line: ${line.slice(0, 120)}`);
      continue;
    }
    paths.push(match[1]);
  }
  return paths;
}

// Path discipline mirrors the rest of this repo's guards: a submodule path is
// consumed as data, never trusted to stay inside the tree it came from.
function resolveInsideRoot(root, relative) {
  if (relative.startsWith('"')) {
    fail(`refusing quoted submodule path: ${relative.slice(0, 120)}`);
    return null;
  }
  if (relative.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`refusing unsafe submodule path: ${relative.slice(0, 120)}`);
    return null;
  }
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    fail(`submodule path escapes the repository root: ${relative.slice(0, 120)}`);
    return null;
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return null; // uninitialized; already reported by the pin check above
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`submodule path is not a real directory: ${relative.slice(0, 120)}`);
    return null;
  }
  return absolute;
}

function validateRecursive(root) {
  const paths = submodulePaths(root);
  if (!paths) return;
  for (const relative of paths) {
    const absolute = resolveInsideRoot(root, relative);
    if (!absolute) continue;
    const status = run(absolute, "git", ["status", "--porcelain", "--untracked-files=all"]);
    if (status.status !== 0) {
      fail(`${relative} worktree status failed: ${status.stderr.trim() || "unknown error"}`);
      continue;
    }
    const entries = status.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length) continue;
    // Uncommitted submodule content is unshippable by construction: the parent
    // can only ever pin a commit, so anything not committed here is silently
    // dropped from every consumer's checkout.
    fail(
      `${relative} worktree is dirty; commit and push it, then bump the parent pin ` +
        `(${entries.length} uncommitted change(s), e.g. ${entries.slice(0, 5).map((entry) => entry.trim()).join(", ")})`,
    );
  }
}

function assertNoForbiddenPayload(paths, surface) {
  for (const path of paths) {
    const normalized = path.replace(/^package\//, "").replace(/\/$/, "");
    const forbidden = FORBIDDEN_TRACKED.find(({ pattern }) => pattern.test(normalized));
    if (forbidden) fail(`${surface} contains ${forbidden.label}: ${path}`);
  }
}

function validateArchive(root, contract) {
  const archive = run(root, "git", ["archive", "--format=tar", "HEAD"], { encoding: null });
  if (archive.status !== 0) return fail(archive.stderr?.toString().trim() || "git archive failed");
  const listing = run(root, "tar", ["-tf", "-"], { input: archive.stdout });
  if (listing.status !== 0) return fail(listing.stderr.trim() || "tar listing failed");
  assertNoForbiddenPayload(listing.stdout.split(/\r?\n/).filter(Boolean), "git archive");

  // A parent git archive records a submodule commit, not its expanded files.
  // Prove the required runtime assets exist byte-for-byte in that pinned Git
  // object rather than trusting a possibly modified submodule worktree.
  const submodulePath = "templates/hermes-agent";
  const pin = contract.gitlinks.get(submodulePath)?.sha;
  const submoduleRoot = resolveInsideRoot(root, submodulePath);
  if (!pin || !submoduleRoot) {
    fail("Hermes template pin must be initialized for archive verification");
    return;
  }
  if (pin !== HERMES_TEMPLATE_MANIFEST.commit) {
    fail(`Hermes gitlink ${pin} differs from immutable template manifest ${HERMES_TEMPLATE_MANIFEST.commit}`);
  }
  for (const asset of REQUIRED_HERMES_PACKAGE_ASSETS) {
    const treeEntry = run(
      submoduleRoot,
      "git",
      ["ls-tree", pin, "--", asset.submodulePath],
    );
    const expectedEntry = `${asset.identity.mode} blob ${asset.identity.gitBlob}\t${asset.submodulePath}`;
    if (treeEntry.status !== 0 || treeEntry.stdout.trim() !== expectedEntry) {
      fail(`Hermes pinned archive has wrong blob identity for ${asset.submodulePath}`);
      continue;
    }
    const archived = run(
      submoduleRoot,
      "git",
      ["show", `${pin}:${asset.submodulePath}`],
      { encoding: null },
    );
    if (archived.status !== 0) {
      fail(`Hermes pinned archive is missing ${asset.submodulePath}`);
      continue;
    }
    const local = readFileSync(resolve(root, asset.packagePath));
    if (!Buffer.from(archived.stdout).equals(local)) {
      fail(`Hermes pinned archive differs from ${asset.packagePath}`);
    }
  }
}

function validateNpm(root) {
  const destination = mkdtempSync(join(tmpdir(), "pjangler-npm-contract-"));
  try {
    // A dry-run listing cannot prove payload bytes. Build the same scripts-off
    // tarball npm would publish in an isolated directory, then compare each
    // security-critical runtime asset with its canonical checked-out bytes.
    const result = run(root, "npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ]);
    if (result.status !== 0) return fail(result.stderr.trim() || "npm pack failed");
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return fail("npm pack returned invalid JSON");
    }
    const packRecord = Array.isArray(payload) ? payload[0] : Object.values(payload ?? {})[0];
    const files = packRecord?.files?.map((entry) => entry.path) ?? [];
    const packedFiles = new Map(packRecord?.files?.map((entry) => [entry.path, entry]) ?? []);
    assertNoForbiddenPayload(files, "npm package");
    const requiredFiles = [
      "templates/commonproject/copier.yml",
      ...REQUIRED_HERMES_PACKAGE_ASSETS.map((asset) => asset.packagePath),
    ];
    for (const required of requiredFiles) {
      if (!files.includes(required)) fail(`npm package is missing populated ${required}`);
    }

    const tarball = packRecord?.filename ? join(destination, packRecord.filename) : undefined;
    if (!tarball) {
      fail("npm pack did not report its tarball filename");
      return;
    }
    for (const asset of REQUIRED_HERMES_PACKAGE_ASSETS) {
      if (!files.includes(asset.packagePath)) continue;
      const packedMode = packedFiles.get(asset.packagePath)?.mode;
      const expectedMode = asset.identity.mode === "100755" ? 0o755 : 0o644;
      if (packedMode !== expectedMode) {
        fail(`npm package mode differs from canonical ${asset.packagePath}`);
        continue;
      }
      const packed = run(root, "tar", ["-xOf", tarball, `package/${asset.packagePath}`], { encoding: null });
      if (packed.status !== 0) {
        fail(`npm package cannot read ${asset.packagePath}`);
        continue;
      }
      if (!Buffer.from(packed.stdout).equals(readFileSync(resolve(root, asset.packagePath)))) {
        fail(`npm package bytes differ from canonical ${asset.packagePath}`);
      }
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
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
  if (args.includes("--archive")) validateArchive(root, contract);
  if (args.includes("--npm")) validateNpm(root);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!process.exitCode) process.stdout.write("submodule-contract: verified\n");
