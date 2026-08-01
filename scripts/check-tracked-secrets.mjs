import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const maxBuffer = 64 * 1024 * 1024;
const findings = [];
const infrastructureFailures = [];
const scannedWorkingContent = new Map();
let scanned = 0;

// Alphanumeric boundaries are deliberate: `_` and `-` are common filename
// separators and must not hide a JWT, even though they are base64url symbols.
const rawJwtSource = String.raw`(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])`;
const bearerCredential = /\bauthorization\b\s*[:=]\s*["']?\s*bearer\s+([^\s"',\\]+)/gi;
const assignedCredential = /["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password)["']?\s*[:=]\s*(?:["']([^"'\r\n]+)["']|([^\s"',\]]+))/gi;

// This legacy transcript is JWT-free but contains code/examples that resemble
// assignments. The exception is content-addressed: any byte change restores
// the full session/review credential heuristic automatically.
const auditedSensitiveArtifactBlobs = new Map([
  [
    "sessions/2026/06/07/rollout-2026-06-07T16-09-07-019ea3b4-0ebe-7722-b5a0-402c0bb4d429.jsonl",
    "665adeb1d8d60d5997b0242c945469463d973c7c",
  ],
]);

function rawJwtPattern() {
  return new RegExp(rawJwtSource, "g");
}

function displayPath(path) {
  return JSON.stringify(path.replace(rawJwtPattern(), "[REDACTED-JWT]"));
}

function isSensitiveArtifact(path) {
  return (
    path === "review.md" ||
    path.endsWith("/review.md") ||
    path.startsWith("sessions/") ||
    path.includes("/sessions/")
  );
}

function isSafeReference(value) {
  const candidate = value.trim();
  return (
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(candidate) ||
    /^\$[A-Z][A-Z0-9_]*$/.test(candidate) ||
    /^op:\/\/[^/\s]+(?:\/[^/\s]+){2,3}$/.test(candidate) ||
    /^(?:<|\[)redacted(?:>|\])$/i.test(candidate) ||
    /^(?:your|example|dummy|test)[_-](?:api[_-]?key|token|secret|password)(?:[_-]here)?$/i.test(candidate) ||
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)[_-](?:not[_-]found|missing|unset)$/i.test(candidate) ||
    /^\*{3,}$/.test(candidate)
  );
}

function isCredentialCandidate(candidate, quoted) {
  if (isSafeReference(candidate) || candidate.length < 12 || candidate.includes("\\")) {
    return false;
  }
  if (quoted) return true;
  return (
    /^[A-Za-z0-9_+/=-]+$/.test(candidate) ||
    candidate.startsWith("$") ||
    candidate.startsWith("op://")
  );
}

function countLiteralCredentials(content) {
  let count = 0;
  bearerCredential.lastIndex = 0;
  for (const match of content.matchAll(bearerCredential)) {
    const candidate = match[1].trim();
    if (isCredentialCandidate(candidate, false)) count += 1;
  }
  assignedCredential.lastIndex = 0;
  for (const match of content.matchAll(assignedCredential)) {
    const quoted = match[1] !== undefined;
    const candidate = (match[1] ?? match[2] ?? "").trim();
    if (isCredentialCandidate(candidate, quoted)) count += 1;
  }
  return count;
}

function scanContent(path, content, sourceSuffix = "", scanCredentialAssignments = true) {
  const jwtCount = (content.match(rawJwtPattern()) ?? []).length;
  if (jwtCount > 0) {
    findings.push({
      path,
      reason: `high-confidence raw JWT${sourceSuffix}`,
      count: jwtCount,
    });
  }

  if (scanCredentialAssignments && isSensitiveArtifact(path)) {
    const credentialCount = countLiteralCredentials(content);
    if (credentialCount > 0) {
      findings.push({
        path,
        reason: `literal credential in session/review artifact${sourceSuffix}`,
        count: credentialCount,
      });
    }
  }
}

function readWorkingContent(path, failureReason) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return readlinkSync(path);
    if (stat.isFile()) return readFileSync(path, "utf8");
    infrastructureFailures.push({ path, reason: failureReason, count: 1 });
  } catch {
    infrastructureFailures.push({ path, reason: failureReason, count: 1 });
  }
  return undefined;
}

function enumerateIndex() {
  const git = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer,
  });

  if (git.error || git.status !== 0) {
    console.error("tracked-secret gate: ERROR (unable to enumerate the Git index)");
    console.error("Secret values are intentionally omitted.");
    process.exit(2);
  }

  const entries = [];
  for (const record of git.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const metadata = separator >= 0 ? record.slice(0, separator).split(" ") : [];
    if (metadata.length !== 3) {
      infrastructureFailures.push({
        path: "[index-entry]",
        reason: "malformed Git index entry",
        count: 1,
      });
      continue;
    }
    const [mode, objectId, stage] = metadata;
    const path = record.slice(separator + 1);
    if (stage !== "0") {
      infrastructureFailures.push({
        path,
        reason: "unmerged Git index entry",
        count: 1,
      });
      continue;
    }
    entries.push({ mode, objectId, path });
  }
  return entries;
}

function scanIndexAndTrackedWorktree(entries) {
  for (const { mode, objectId, path } of entries) {
    const pathJwtCount = (path.match(rawJwtPattern()) ?? []).length;
    if (pathJwtCount > 0) {
      findings.push({
        path,
        reason: "high-confidence raw JWT in tracked path",
        count: pathJwtCount,
      });
    }

    // A gitlink has no blob in the superproject. Its publishable working-tree
    // files are covered by the npm pack payload scan below.
    if (mode === "160000") continue;

    const blob = spawnSync("git", ["cat-file", "blob", objectId], {
      cwd: root,
      encoding: "buffer",
      maxBuffer,
    });
    if (blob.error || blob.status !== 0) {
      infrastructureFailures.push({
        path,
        reason: "tracked index content could not be scanned",
        count: 1,
      });
      continue;
    }

    const indexedContent = blob.stdout.toString("utf8");
    scanContent(
      path,
      indexedContent,
      "",
      auditedSensitiveArtifactBlobs.get(path) !== objectId,
    );
    scanned += 1;

    const workingContent = readWorkingContent(
      path,
      "tracked working-tree content could not be scanned",
    );
    if (workingContent === undefined) continue;
    scannedWorkingContent.set(path, workingContent);
    if (workingContent !== indexedContent) {
      scanContent(path, workingContent, " in tracked working tree");
    }
  }
}

function enumeratePackagePayload() {
  const pack = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent" },
      maxBuffer,
    },
  );
  if (pack.error || pack.status !== 0) {
    infrastructureFailures.push({
      path: "package.json",
      reason: "npm package payload could not be enumerated",
      count: 1,
    });
    return [];
  }

  let manifest;
  try {
    manifest = JSON.parse(pack.stdout);
  } catch {
    infrastructureFailures.push({
      path: "package.json",
      reason: "npm package payload was not valid JSON",
      count: 1,
    });
    return [];
  }

  const packages = Array.isArray(manifest)
    ? manifest
    : manifest && typeof manifest === "object"
      ? Object.values(manifest)
      : [];
  if (packages.length === 0 || !packages.every((item) => Array.isArray(item.files))) {
    infrastructureFailures.push({
      path: "package.json",
      reason: "npm package payload had an unexpected shape",
      count: 1,
    });
    return [];
  }

  const paths = new Set();
  for (const item of packages) {
    for (const file of item.files) {
      if (typeof file.path !== "string") {
        infrastructureFailures.push({
          path: "package.json",
          reason: "npm package payload contained an invalid path",
          count: 1,
        });
        continue;
      }
      const normalized = normalize(file.path);
      if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        infrastructureFailures.push({
          path: "package.json",
          reason: "npm package payload escaped the repository root",
          count: 1,
        });
        continue;
      }
      paths.add(normalized);
    }
  }
  return [...paths];
}

function scanPackagePayload(paths) {
  for (const path of paths) {
    const pathJwtCount = (path.match(rawJwtPattern()) ?? []).length;
    if (pathJwtCount > 0) {
      findings.push({
        path,
        reason: "high-confidence raw JWT in npm package path",
        count: pathJwtCount,
      });
    }

    const content = readWorkingContent(path, "npm package payload content could not be scanned");
    if (content === undefined) continue;
    if (scannedWorkingContent.get(path) === content) continue;
    scanContent(path, content, " in npm package payload");
    scanned += 1;
  }
}

const entries = enumerateIndex();
scanIndexAndTrackedWorktree(entries);
scanPackagePayload(enumeratePackagePayload());

if (infrastructureFailures.length > 0) {
  const failureCount = infrastructureFailures.reduce((total, failure) => total + failure.count, 0);
  console.error(`tracked-secret gate: ERROR (${failureCount} infrastructure failure(s))`);
  for (const { path, reason, count } of infrastructureFailures) {
    console.error(`- ${displayPath(path)}: ${reason} (${count})`);
  }
  console.error("Secret values are intentionally omitted.");
  process.exit(2);
}

if (findings.length > 0) {
  const affectedPaths = new Set(findings.map(({ path }) => path)).size;
  const findingCount = findings.reduce((total, finding) => total + finding.count, 0);
  console.error(
    `tracked-secret gate: FAIL (${findingCount} finding(s) across ${affectedPaths} path(s))`,
  );
  for (const { path, reason, count } of findings) {
    console.error(`- ${displayPath(path)}: ${reason} (${count})`);
  }
  console.error("Secret values are intentionally omitted.");
  process.exit(1);
}

console.log(`tracked-secret gate: PASS (${scanned} tracked/package path(s) scanned)`);
