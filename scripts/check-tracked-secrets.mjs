import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const git = spawnSync("git", ["ls-files", "--stage", "-z"], {
  cwd: process.cwd(),
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024,
});

if (git.error || git.status !== 0) {
  console.error("tracked-secret gate: ERROR (unable to enumerate tracked paths)");
  process.exit(2);
}

const trackedEntries = git.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((record) => {
    const separator = record.indexOf("\t");
    const [mode, objectId, stage] = record.slice(0, separator).split(" ");
    return { mode, objectId, stage, path: record.slice(separator + 1) };
  })
  .filter(({ stage }) => stage === "0");

const rawJwtSource = String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`;
const bearerCredential = /\bauthorization\b\s*[:=]\s*["']?\s*bearer\s+([^\s"',}\\]+)/gi;
const assignedCredential = /["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password)["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi;

function isSensitiveArtifact(path) {
  return (
    path === "review.md" ||
    path.endsWith("/review.md") ||
    path.startsWith("sessions/") ||
    path.includes("/sessions/")
  );
}

function rawJwtPattern() {
  return new RegExp(rawJwtSource, "g");
}

function displayPath(path) {
  return JSON.stringify(path.replace(rawJwtPattern(), "[REDACTED-JWT]"));
}

function isSafeReference(value) {
  const candidate = value.trim();
  return (
    candidate.startsWith("${") ||
    /^\$[A-Z_][A-Z0-9_]*$/i.test(candidate) ||
    candidate.startsWith("op://") ||
    /^(?:<|\[)?redacted(?:>|\])?$/i.test(candidate) ||
    /^\*+$/.test(candidate)
  );
}

function countLiteralCredentials(content) {
  let count = 0;
  for (const pattern of [bearerCredential, assignedCredential]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (!isSafeReference(match[1])) count += 1;
    }
  }
  return count;
}

const findings = [];
let scanned = 0;

function scanContent(path, content, sourceSuffix = "") {
  const jwtCount = (content.match(rawJwtPattern()) ?? []).length;
  if (jwtCount > 0) {
    findings.push({
      path,
      reason: `high-confidence raw JWT${sourceSuffix}`,
      count: jwtCount,
    });
  }

  if (isSensitiveArtifact(path)) {
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

for (const { mode, objectId, path } of trackedEntries) {
  const pathJwtCount = (path.match(rawJwtPattern()) ?? []).length;
  if (pathJwtCount > 0) {
    findings.push({ path, reason: "high-confidence raw JWT in tracked path", count: pathJwtCount });
  }

  if (mode === "160000") continue;

  const blob = spawnSync("git", ["cat-file", "blob", objectId], {
    cwd: process.cwd(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (blob.error || blob.status !== 0) {
    findings.push({ path, reason: "tracked index content could not be scanned", count: 1 });
    continue;
  }

  const indexedContent = blob.stdout.toString("utf8");
  scanContent(path, indexedContent);
  scanned += 1;

  let workingContent;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      workingContent = readlinkSync(path);
    } else if (stat.isFile()) {
      workingContent = readFileSync(path, "utf8");
    } else {
      continue;
    }
  } catch {
    continue;
  }

  if (workingContent !== indexedContent) {
    scanContent(path, workingContent, " in tracked working tree");
  }
}

if (findings.length > 0) {
  const affectedPaths = new Set(findings.map(({ path }) => path)).size;
  const findingCount = findings.reduce((total, finding) => total + finding.count, 0);
  console.error(
    `tracked-secret gate: FAIL (${findingCount} finding(s) across ${affectedPaths} tracked path(s))`,
  );
  for (const { path, reason, count } of findings) {
    console.error(`- ${displayPath(path)}: ${reason} (${count})`);
  }
  console.error("Secret values are intentionally omitted.");
  process.exit(1);
}

console.log(`tracked-secret gate: PASS (${scanned} tracked path(s) scanned)`);
