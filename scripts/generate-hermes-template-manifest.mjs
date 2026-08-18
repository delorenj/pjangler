#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = join(root, "templates", "hermes-agent");
const output = join(root, "hermes-template-assets.json");

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd: templateRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout;
}

const dirty = git(["status", "--porcelain", "--", "copier.yml", "template"]);
if (dirty.trim()) {
  throw new Error("Hermes copier.yml/template tree must be committed before generating its immutable manifest");
}

const commit = git(["rev-parse", "HEAD"]).trim();
const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", "copier.yml", "template"]);
const files = {};
for (const record of tree.split("\0").filter(Boolean)) {
  const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/s);
  if (!match) throw new Error(`unsupported Hermes template tree entry: ${JSON.stringify(record)}`);
  const [, mode, gitBlob, path] = match;
  if (path !== "copier.yml" && !path.startsWith("template/")) {
    throw new Error(`Hermes manifest path escapes the Copier tree: ${path}`);
  }
  const bytes = git(["show", `${commit}:${path}`], null);
  files[path] = {
    gitBlob,
    sha256: createHash("sha256").update(bytes).digest("base64url"),
    mode,
  };
}
if (!Object.hasOwn(files, "copier.yml") || !Object.keys(files).some((path) => path.startsWith("template/"))) {
  throw new Error("Hermes manifest source tree is incomplete");
}

const rendered = `${JSON.stringify({ version: 1, commit, files }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== rendered) {
    throw new Error("hermes-template-assets.json is stale; regenerate it from the pinned submodule commit");
  }
  process.stdout.write(`Hermes template manifest matches ${commit}\n`);
} else {
  writeFileSync(output, rendered, "utf8");
  process.stdout.write(`Wrote ${output} for ${commit} (${Object.keys(files).length} files)\n`);
}
