import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

export const BMAD_PACK_VERSION = "6.10.1-next.31";
export const BMAD_PACK_CHECKSUMS_SHA256 = "a8bc005612ac60e3ec775fff5a11eafe38be6acdae96efa3d770b48322cb3224";
export const BMAD_PACK_SKILL_COUNT = 76;
export const BMAD_PACK_PAYLOAD_FILES = 1072;

export interface TrustedBmadPack {
  root: string;
  skillNames: string[];
  payloadFiles: number;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readRegularFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`BMAD pack entry is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe BMAD checksum path: ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePackToml(content: string): { skillNames: string[]; payloadFiles: number } {
  const required = [
    /^name = "bmad"$/m,
    new RegExp(`^version = "${BMAD_PACK_VERSION.replaceAll(".", "\\.")}"$`, "m"),
    /^upstream = "bmad-method"$/m,
    new RegExp(`^upstream_version = "${BMAD_PACK_VERSION.replaceAll(".", "\\.")}"$`, "m"),
    /^rendered_from = "\.agent\/skills"$/m,
    /^immutable = true$/m,
    /^project_projection = "symlink"$/m,
  ];
  if (required.some((pattern) => !pattern.test(content))) {
    throw new Error(`BMAD pack.toml does not declare the trusted ${BMAD_PACK_VERSION} contract`);
  }
  const payloadMatch = content.match(/^payload_files = (\d+)$/m);
  const skillsMatch = content.match(/^skills = \[\n([\s\S]*?)^\]$/m);
  if (!payloadMatch || !skillsMatch) throw new Error("BMAD pack.toml is missing payload inventory metadata");
  const skillNames = [...skillsMatch[1]!.matchAll(/^\s+"([^"]+)",$/gm)].map((match) => match[1]!);
  const payloadFiles = Number.parseInt(payloadMatch[1]!, 10);
  if (skillNames.length !== BMAD_PACK_SKILL_COUNT || new Set(skillNames).size !== skillNames.length) {
    throw new Error(`BMAD pack.toml must declare exactly ${BMAD_PACK_SKILL_COUNT} unique skills`);
  }
  if (payloadFiles !== BMAD_PACK_PAYLOAD_FILES) {
    throw new Error(`BMAD pack.toml must declare exactly ${BMAD_PACK_PAYLOAD_FILES} payload files`);
  }
  for (const name of skillNames) {
    if (!name.startsWith("bmad-") || basename(name) !== name) throw new Error(`Unsafe BMAD skill identity: ${name}`);
  }
  return { skillNames, payloadFiles };
}

function walkRegularTree(root: string): { files: Map<string, Buffer>; directories: Set<string> } {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`BMAD pack may not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        directories.add(relative(root, path).split(sep).join("/"));
        visit(path);
      }
      else if (stat.isFile()) files.set(relative(root, path).split(sep).join("/"), readRegularFile(path));
      else throw new Error(`BMAD pack may contain only regular files/directories: ${path}`);
    }
  };
  visit(root);
  return { files, directories };
}

export function validateTrustedBmadPack(packRoot: string): TrustedBmadPack {
  const root = resolve(packRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`BMAD pack root must be a real directory: ${root}`);
  }

  const checksumsContent = readRegularFile(join(root, "SHA256SUMS"));
  if (sha256(checksumsContent) !== BMAD_PACK_CHECKSUMS_SHA256) {
    throw new Error(`BMAD pack checksum manifest is not the trusted ${BMAD_PACK_VERSION} manifest`);
  }
  const expected = new Map<string, string>();
  for (const line of checksumsContent.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid BMAD SHA256SUMS entry: ${line}`);
    const path = safeRelativePath(match[2]!);
    if (expected.has(path)) throw new Error(`Duplicate BMAD SHA256SUMS entry: ${path}`);
    expected.set(path, match[1]!);
  }

  const walked = walkRegularTree(root);
  const actual = walked.files;
  actual.delete("SHA256SUMS");
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  if (missing.length || extra.length) {
    throw new Error(`BMAD checksum coverage mismatch; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  for (const [path, digest] of expected) {
    const content = actual.get(path);
    if (!content || sha256(content) !== digest) throw new Error(`BMAD pack digest mismatch: ${path}`);
  }
  for (const directory of walked.directories) {
    if (![...actual.keys()].some((path) => path.startsWith(`${directory}/`))) {
      throw new Error(`BMAD pack contains an unauthenticated empty directory: ${directory}`);
    }
  }

  const packToml = actual.get("pack.toml");
  if (!packToml) throw new Error("BMAD pack.toml is missing");
  const metadata = parsePackToml(packToml.toString("utf8"));
  const skillSet = new Set(metadata.skillNames);
  const topLevelDirectories = readdirSync(root)
    .filter((name) => lstatSync(join(root, name)).isDirectory())
    .sort();
  if (topLevelDirectories.length !== skillSet.size || topLevelDirectories.some((name) => !skillSet.has(name))) {
    throw new Error("BMAD pack directory inventory differs from authenticated pack.toml skills");
  }
  for (const name of metadata.skillNames) {
    const skillMd = join(root, name, "SKILL.md");
    if (!lstatSync(skillMd).isFile() || lstatSync(skillMd).isSymbolicLink()) {
      throw new Error(`BMAD skill is missing a regular SKILL.md: ${name}`);
    }
  }
  const payloadCount = [...actual.keys()].filter((path) => skillSet.has(path.split("/", 1)[0]!)).length;
  if (payloadCount !== metadata.payloadFiles) {
    throw new Error(`BMAD payload inventory mismatch: ${payloadCount} != ${metadata.payloadFiles}`);
  }
  return { root, skillNames: metadata.skillNames, payloadFiles: metadata.payloadFiles };
}
