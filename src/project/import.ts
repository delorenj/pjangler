import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readActivationReceipt } from "@delorenj/skillex";
import { readManifest } from "./manifestIndex";
import { normalizeProjectId, registryRequest, resolveRegistryLocation, isRegistryServiceLocation } from "./registryClient";

export interface ImportOptions {
  source: string;
  parent: string;
  name?: string;
  registry?: string;
  bindingsHome?: string;
  dryRun?: boolean;
}
interface LinkChange { path: string; before: string; after: string; inside: boolean }
export interface ImportPlan {
  mode: "local" | "remote";
  source: string;
  target: string;
  name: string;
  url: string;
  projectId?: string;
  registry: string;
  changes: string[];
  bindings: LinkChange[];
}
export interface ImportResult {
  ok: boolean;
  status: "planned" | "imported" | "unchanged" | "refused" | "rolled_back" | "recovery_required";
  plan?: ImportPlan;
  error?: string;
  recovery?: { receipt?: string; checkout: string; instructions: string[]; errors: string[] };
}
interface Snapshot { path: string; bytes?: Buffer; mode?: number }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const present = (path: string) => { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
const mapped = (path: string, source: string, target: string) => inside(source, path) ? resolve(target, relative(source, path)) : path;
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, input, encoding: "utf8", shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}
function maybeGit(cwd: string, args: string[]): string | undefined {
  try { return git(cwd, args); } catch { return undefined; }
}
function snapshot(path: string): Snapshot {
  if (!present(path)) return { path };
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  return { path, bytes: readFileSync(path), mode: s.mode & 0o777 };
}
function matches(s: Snapshot): boolean {
  if (s.bytes === undefined) return !present(s.path);
  return present(s.path) && lstatSync(s.path).isFile() && !lstatSync(s.path).isSymbolicLink() && (lstatSync(s.path).mode & 0o777) === s.mode && readFileSync(s.path).equals(s.bytes);
}
function atomic(path: string, bytes: Buffer | string, mode = 0o644): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, bytes, { flag: "wx", mode }); renameSync(temp, path); }
  finally { if (present(temp)) unlinkSync(temp); }
}
function restore(before: Snapshot, expected: Snapshot): void {
  if (!matches(expected)) throw new Error(`Concurrent writer changed ${before.path}; recovery must preserve it`);
  if (before.bytes === undefined) { if (present(before.path)) unlinkSync(before.path); }
  else atomic(before.path, before.bytes, before.mode);
}
function standalone(root: string): { gitDir: string; head: string; index: Snapshot } {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`Checkout must be a real directory: ${root}`);
  if (!present(join(root, ".git")) || !lstatSync(join(root, ".git")).isDirectory() || lstatSync(join(root, ".git")).isSymbolicLink()) throw new Error(`Unsupported worktree or external Git directory: ${root}`);
  const gitDir = realpathSync(join(root, ".git"));
  if (present(join(gitDir, "index.lock"))) throw new Error(`Git index lock exists for checkout ${root}; finish that operation before import`);
  if (git(root, ["rev-parse", "--show-toplevel"]) !== root || git(root, ["rev-parse", "--absolute-git-dir"]) !== gitDir) throw new Error(`Unsupported worktree layout: ${root}`);
  if (git(root, ["worktree", "list", "--porcelain"]).split("\n").filter(l => l.startsWith("worktree ")).length !== 1) throw new Error(`Unsupported multiple worktrees: ${root}`);
  if (maybeGit(root, ["config", "--get", "core.worktree"])) throw new Error(`Unsupported core.worktree binding: ${root}`);
  if (git(root, ["ls-files", "--unmerged"])) throw new Error(`Unmerged index must be resolved before import: ${root}`);
  return { gitDir, head: git(root, ["rev-parse", "--verify", "HEAD"]), index: snapshot(join(gitDir, "index")) };
}
function cleanModules(parent: string): void {
  if (present(join(parent, ".gitmodules")) && !git(parent, ["ls-files", "--", ".gitmodules"])) throw new Error("Untracked .gitmodules must be reviewed and staged before import");
  if (maybeGit(parent, ["diff", "--quiet", "HEAD", "--", ".gitmodules"]) === undefined) throw new Error(".gitmodules has staged or unstaged changes; finish that enrollment first");
}
function replaceLink(path: string, before: string, after: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    symlinkSync(after, temp);
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== before) throw new Error(`Concurrent binding writer changed ${path}; preserve it`);
    renameSync(temp, path);
  } finally { if (present(temp)) unlinkSync(temp); }
}

export function importSource(input: string, cwd: string): { mode: "local" | "remote"; source: string; url: string; name: string } {
  if (!input || input.includes("\0") || input.startsWith("-")) throw new Error("Invalid import source");
  let url = input;
  if (/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(input)) url = `https://${input.replace(/\/$/, "").replace(/\.git$/, "")}.git`;
  const remote = /^(?:https?|ssh|git|file):\/\//.test(url) || /^[^\s/:]+@[^\s/:]+:.+/.test(url);
  if (remote) {
    if (/[\r\n]/.test(url)) throw new Error("Invalid repository URL");
    if (url.includes("://")) {
      const parsed = new URL(url);
      if (parsed.password || ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username) || parsed.search || parsed.hash) throw new Error("Repository URL must not contain credentials, a query or fragment");
    }
    return { mode: "remote", source: url, url, name: basename(url.replace(/\/$/, "")).replace(/\.git$/, "") };
  }
  const source = resolve(cwd, input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
  const bare = present(source) && lstatSync(source).isDirectory() && maybeGit(source, ["rev-parse", "--is-bare-repository"]) === "true";
  return { mode: bare ? "remote" : "local", source, url: bare ? source : "", name: basename(source).replace(/\.git$/, "") };
}

function linkPlan(root: string, target: string, home: string, local: boolean, explicitHome: boolean): LinkChange[] {
  const links: LinkChange[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === ".git") {
        if (dir !== root && !lstatSync(join(dir, name)).isDirectory()) throw new Error(`Unsupported nested worktree at ${dir}`);
        continue;
      }
      const path = join(dir, name), s = lstatSync(path);
      if (s.isSymbolicLink()) {
        const before = readlinkSync(path), oldTarget = resolve(dirname(path), before);
        const newTarget = mapped(oldTarget, root, target), newPath = mapped(path, root, target);
        const after = isAbsolute(before) ? newTarget : relative(dirname(newPath), newTarget);
        if (before !== after) links.push({ path, before, after, inside: true });
      } else if (s.isDirectory()) walk(path);
    }
  }
  walk(root);
  if (!local) {
    if (links.some(l => !inside(root, resolve(dirname(l.path), l.before)))) throw new Error("Remote checkout has relative links escaping its root; resolve their binding before import");
    return links;
  }
  const bin = join(home, ".local", "bin");
  if (present(bin)) for (const name of readdirSync(bin)) {
    const path = join(bin, name), s = lstatSync(path);
    if (s.isSymbolicLink()) {
      const before = readlinkSync(path), oldTarget = resolve(dirname(path), before);
      if (inside(root, oldTarget)) {
        if (!statSync(oldTarget).isFile()) throw new Error(`Unsupported executable target at ${path}`);
        accessSync(oldTarget, constants.X_OK);
        const newTarget = mapped(oldTarget, root, target); links.push({ path, before, after: isAbsolute(before) ? newTarget : relative(bin, newTarget), inside: false });
      }
    } else if (s.isFile() && s.size <= 1024 * 1024 && readFileSync(path).includes(Buffer.from(root))) {
      throw new Error(`Unsupported executable binding at ${path}: its owner must supply a relocation adapter (Pilot/config path-binding contract missing); nothing was moved`);
    }
  }
  function serviceBindings(dir: string) {
    if (!present(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), s = lstatSync(path);
      if (s.isSymbolicLink()) { if (inside(root, resolve(dirname(path), readlinkSync(path)))) throw new Error(`Unsupported service binding at ${path}: Flume relocation contract missing (FLUME-41, service/unit bindings); nothing was moved`); }
      else if (s.isDirectory()) serviceBindings(path);
      else if (s.isFile() && s.size <= 1024 * 1024 && readFileSync(path).includes(Buffer.from(root))) throw new Error(`Unsupported service binding at ${path}: Flume relocation contract missing (FLUME-41, service/unit bindings); nothing was moved`);
    }
  }
  const configHome = explicitHome ? join(home, ".config") : process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  serviceBindings(join(configHome, "systemd", "user"));
  const pilotConfig = !explicitHome && process.env.PILOT_CONFIG_DIR ? resolve(process.env.PILOT_CONFIG_DIR) : join(configHome, "pilot");
  const configFile = join(pilotConfig, "config.json");
  for (const path of [configFile, join(pilotConfig, "default.schema.json")]) if (present(path) && lstatSync(path).isSymbolicLink() && inside(root, resolve(dirname(path), readlinkSync(path)))) throw new Error(`Pilot config binding at ${path} requires its owner's relocation adapter (Pilot/config path-binding contract missing); nothing was moved`);
  if (present(configFile)) {
    let config: Record<string, unknown>;
    try { config = JSON.parse(readFileSync(configFile, "utf8")); }
    catch { throw new Error(`Pilot config cannot be parsed; repair its owning config before import (${configFile})`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Pilot config must be an object (${configFile})`);
    for (const key of ["defaultSchema", "default_schema", "manifestRegistry"]) {
      const value = config[key];
      if (typeof value === "string" && inside(root, resolve(value.startsWith("~/") ? join(home, value.slice(2)) : value))) throw new Error(`Pilot ${key} binding requires its owner's relocation adapter (Pilot/config path-binding contract missing); nothing was moved (${configFile})`);
    }
  }
  return links;
}
async function ownedCapabilities(root: string, manifest: Record<string, any>, home: string): Promise<void> {
  if (Object.keys(manifest.agents ?? {}).length || present(join(root, "agents", "hermes"))) throw new Error("Flume relocation contract missing (FLUME-41, Backlog): identity-preserving employee/profile/runtime/service relocation is owned by Flume and is not delivered; nothing was moved");
  const registry = join(home, ".hermes", "agents-registry.yaml");
  if (present(registry)) {
    const result = spawnSync("flume", ["roster", "--agent-registry", registry, "--json"], { encoding: "utf8", timeout: 30_000, shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Flume roster could not prove employee bindings; run its public read-only roster before relocation");
    let inventory: any;
    try { inventory = JSON.parse(result.stdout); } catch { throw new Error("Flume roster returned invalid JSON; employee relocation cannot be assessed"); }
    if (!inventory.ok || inventory.data?.truncated?.length || !Array.isArray(inventory.data?.rows)) throw new Error("Flume roster is incomplete; employee relocation cannot be assessed");
    if (JSON.stringify(inventory.data.rows).includes(root)) throw new Error("Flume relocation contract missing (FLUME-41, Backlog) for the roster's project bindings: identity-preserving employee/profile/service relocation is owned by Flume and is not delivered; nothing was moved");
  }
  const receipt = await readActivationReceipt(root, { home, env: process.env });
  if (receipt.document) throw new Error("Skillex relocation contract missing: project-scope activation links and the scopeRoot-keyed ownership receipt cannot be re-anchored by import; the Skillex owner must supply a public from/to relocation; nothing was moved");
  function skillLinks(dir: string): void {
    if (!present(dir)) return;
    const s = lstatSync(dir);
    if (s.isSymbolicLink()) throw new Error("Skillex relocation contract missing: project activation links under .agents/skills cannot be re-anchored by import; copied skills stay untouched; the Skillex owner must supply a public from/to relocation; nothing was moved");
    if (s.isDirectory()) for (const name of readdirSync(dir)) skillLinks(join(dir, name));
  }
  skillLinks(join(root, ".agents", "skills"));
}

type IndexView = { projects: Record<string, any>; __registry_status: Record<string, { manifest_path: string; content_hash: string }> };
function inspect(registry: string): IndexView { return registryRequest(registry, "GET", "/v1/index"); }
function collision(index: IndexView, id: string, source: string, target: string): void {
  const old = index.__registry_status[id]?.manifest_path;
  if (old && old !== join(source, ".project.json") && old !== join(target, ".project.json")) throw new Error(`Registry identity collision for ${id} at ${old}; reindex its authoritative checkout before relocation`);
}

/**
 * A refusal that carries the minimum safe next step. It is still a refusal: the
 * exit code, the status and every byte on disk are exactly what a plain error
 * would leave, but the operator is told what proves, or what blocks, convergence.
 */
class Refusal extends Error {
  constructor(message: string, readonly checkout: string, readonly instructions: string[]) { super(message); }
}
const shellQuote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Where a local import records the path it came from. The journal receipt under
 * .git/pjangler-imports names the source too, but it is a private journal an
 * operator can lose (a scrubbed .git, a parent copied without untracked state).
 * This key lives in the parent's own .git/config, is written and rolled back by
 * the same transaction as the gitlink and .gitmodules, and is what lets a repeat
 * prove the source after the receipt is gone. Exactly one value counts: an
 * ambiguous record proves nothing.
 */
const sourceKey = (name: string) => `pjangler-import.${name}.source`;
function recordedSource(parent: string, name: string): string | undefined {
  const values = (maybeGit(parent, ["config", "--local", "--get-all", sourceKey(name)]) ?? "").split("\n").filter(Boolean);
  return values.length === 1 ? values[0] : undefined;
}

/** Symlinks (in the moved tree and in HOME's .local/bin) that still resolve into `former`: a binding the import should have moved and did not. */
function staleBindings(former: string, target: string, home: string): string[] {
  const stale: string[] = [];
  const points = (path: string) => inside(former, resolve(dirname(path), readlinkSync(path)));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name), s = lstatSync(path);
      if (s.isSymbolicLink()) { if (points(path)) stale.push(path); }
      else if (s.isDirectory()) walk(path);
    }
  };
  walk(target);
  const bin = join(home, ".local", "bin");
  if (present(bin)) for (const name of readdirSync(bin)) { const path = join(bin, name); if (lstatSync(path).isSymbolicLink() && points(path)) stale.push(path); }
  return stale;
}

interface Enrollment { parent: string; name: string; target: string; registry: string; home: string; url: string | undefined; gitlink: string; prior?: any; former?: string }
/**
 * Prove an existing enrollment healthy WITHOUT writing anything: the gitlink is
 * the checkout's HEAD, origin is the .gitmodules URL, the registry binds the
 * project to this very manifest (path and bytes), the manifest's repo_path is
 * the canonical target, and no recorded binding, nor any symlink into the
 * former source, was left behind. Throws the first thing that is not true.
 */
async function verifyEnrollment(e: Enrollment): Promise<{ id: string; url: string; manifestPath: string }> {
  const existing = standalone(realpathSync(e.target));
  if (e.gitlink !== `160000 ${existing.head} 0\t${e.name}` || maybeGit(e.target, ["remote", "get-url", "origin"]) !== e.url) throw new Error(`Existing enrollment drift at ${e.target}; reconcile gitlink and origin before retrying`);
  const manifest = await readManifest(join(e.target, ".project.json"));
  const index = inspect(e.registry);
  if (index.__registry_status[manifest.id]?.manifest_path !== manifest.path || index.__registry_status[manifest.id]?.content_hash !== manifest.hash) throw new Error(`Existing enrollment has stale registry binding; run pj reindex in ${e.target}`);
  if (manifest.manifest.repo_path !== e.target) throw new Error(`Existing enrollment manifest repo_path ${manifest.manifest.repo_path} is not the canonical path ${e.target}; reconcile ${manifest.path} before retrying`);
  for (const l of e.prior?.plan?.bindings ?? []) {
    const path = l.inside ? mapped(l.path, e.prior.plan.source, e.target) : l.path;
    if (!present(path) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== l.after) throw new Error(`Existing executable/symlink binding drift at ${path}; reconcile its owner before retrying`);
  }
  if (e.former !== undefined) {
    const stale = staleBindings(e.former, e.target, e.home);
    if (stale.length) throw new Error(`Existing binding at ${stale[0]} still points into the former source ${e.former}; rebind it (its owner, if it is not a plain symlink) before retrying`);
  }
  return { id: manifest.id, url: e.url!, manifestPath: manifest.path };
}

/**
 * Why an import cannot be reported "unchanged" against a destination that
 * already exists, and what the operator can safely do about it. Never mutates.
 * An enrollment whose provenance is merely UNPROVEN is checked for health here
 * so the message can say so, and only a verified one is offered the one-line
 * provenance record; a mismatch or a source that still exists is a different
 * checkout and is told to pick another --name.
 */
async function collisionRefusal(input: ReturnType<typeof importSource>, claimed: string | undefined, e: Enrollment): Promise<Refusal> {
  const head = `Destination collision: ${e.target}`;
  const other = `import ${input.mode === "local" ? input.source : input.url} under another destination with --name <name>`;
  if (input.mode === "remote") return new Refusal(head, e.target, [`${e.target} is not an enrollment of ${input.url}; ${other}, or reconcile ${e.target} first`]);
  if (claimed !== undefined && claimed !== input.source) return new Refusal(`${head} was imported from ${claimed}, not ${input.source}`, e.target, [`${e.target} belongs to ${claimed}; ${other}`]);
  if (present(input.source)) return new Refusal(head, e.target, [`${input.source} still exists, so it is not the checkout that was moved into ${e.target}; ${other}, or reconcile ${e.target} first`]);
  if (claimed !== undefined) return new Refusal(head, e.target, [`${e.target} is not an enrolled submodule of ${e.parent}; ${other}, or reconcile it first`]);
  const unproven = `${head} already exists and nothing proves it was imported from ${input.source} (no completed import receipt and no provenance record)`;
  let verified: Awaited<ReturnType<typeof verifyEnrollment>>;
  try { verified = await verifyEnrollment({ ...e, former: input.source }); }
  catch (error) {
    return new Refusal(unproven, e.target, [`Nothing was changed. ${e.target} does not verify as a healthy enrollment: ${message(error)}`, `Reconcile that first; only a verified enrollment can be recorded as imported from ${input.source}`]);
  }
  return new Refusal(unproven, e.target, [
    `Nothing was changed. ${e.target} verified healthy: gitlink matches HEAD, origin matches .gitmodules, the registry binds ${verified.id} to ${verified.manifestPath}, and no binding points at ${input.source}`,
    `If ${input.source} really was its source, record that with the one command below, then repeat the import (the repeat re-verifies everything and reports unchanged):`,
    `git -C ${shellQuote(e.parent)} config --local ${sourceKey(e.name)} ${shellQuote(input.source)}`,
    `Otherwise ${other}`,
  ]);
}

export async function importProject(options: ImportOptions): Promise<ImportResult> {
  let plan: ImportPlan | undefined;
  let receiptPath: string | undefined;
  let checkout: string | undefined;
  let lock: number | undefined;
  let lockPath: string | undefined;
  try {
    if (["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].some(key => process.env[key])) throw new Error("Import requires an ordinary Git environment; unset external Git directory/index overrides first");
    const parent = realpathSync(resolve(options.parent));
    const parentGit = standalone(parent);
    const input = importSource(options.source, parent);
    const name = options.name ?? input.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.toLowerCase() === ".git") throw new Error("Destination name must be one safe path segment");
    const target = join(parent, name), home = resolve(options.bindingsHome ?? homedir());
    const registry = resolveRegistryLocation(options.registry);
    if (!isRegistryServiceLocation(registry)) throw new Error("Import enrollment requires the project registry service; pass --registry <URL>");
    plan = { ...input, name, target, registry, changes: [input.mode === "local" ? `Move ${input.source} to ${target}` : `Clone ${input.url} into ${target}`, `Stage .gitmodules and gitlink ${name}; no commit`, ...(input.mode === "local" ? [`Record the source in ${join(parentGit.gitDir, "config")} (${sourceKey(name)}) so a repeat converges even if the receipt is lost`] : []), `Enroll ${join(target, ".project.json")} in ${registry}`], bindings: [] };
    const journalDir = join(parentGit.gitDir, "pjangler-imports");
    receiptPath = join(journalDir, `${name}.json`);
    let prior: any;
    if (present(receiptPath)) {
      prior = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (!["imported", "rolled_back"].includes(prior.status)) throw new Error(`Unfinished import receipt ${receiptPath}; preserve ${prior.checkout ?? target} and complete its recorded recovery before retrying`);
    }
    if (present(target)) {
      const url = maybeGit(parent, ["config", "--file", ".gitmodules", "--get", `submodule.${name}.url`]);
      const gitlink = git(parent, ["ls-files", "--stage", "--", name]);
      const local = input.mode === "local";
      // Provenance of a local import: a COMPLETED receipt, else the durable record in the parent's .git/config.
      // A rolled-back or unfinished receipt proves nothing about a destination that exists.
      const claimed = local ? (prior?.status === "imported" ? prior.plan?.source : recordedSource(parent, name)) : undefined;
      const enrollment: Enrollment = { parent, name, target, registry, home, url, gitlink, prior: prior?.status === "imported" ? prior : undefined, former: local ? input.source : undefined };
      const sameInput = local ? claimed === input.source && !present(input.source) : url === input.url;
      if (!sameInput || !gitlink.startsWith("160000 ")) throw await collisionRefusal(input, claimed, enrollment);
      const verified = await verifyEnrollment(enrollment);
      plan.projectId = verified.id; plan.url = verified.url; plan.changes = [];
      return { ok: true, status: "unchanged", plan };
    }
    if (git(parent, ["ls-files", "--", name]) || maybeGit(parent, ["config", "--file", ".gitmodules", "--get", `submodule.${name}.path`]) || maybeGit(parent, ["config", "--get", `submodule.${name}.url`])) throw new Error(`Submodule/index collision for ${name}`);
    if (maybeGit(parent, ["check-ignore", name]) !== undefined) throw new Error(`Destination ${name} is ignored by the parent; reconcile that rule before import`);
    cleanModules(parent);
    lockPath = join(parentGit.gitDir, "pjangler-import.lock");
    if (present(lockPath) || present(join(parentGit.gitDir, "index.lock"))) throw new Error(`Parent import/Git lock exists; finish its operation before importing`);
    const indexBefore = inspect(registry);
    if (input.mode === "remote" && options.dryRun) {
      plan.changes.push("Inspect fetched manifest, employee/skill ownership and bindings before enrollment; remote contents are not fetched by dry-run");
      return { ok: true, status: "planned", plan };
    }
    if (input.mode === "local") {
      if (!present(input.source)) throw new Error(`Local checkout does not exist: ${input.source}`);
      if (realpathSync(input.source) !== input.source || inside(parent, input.source) || inside(input.source, parent)) throw new Error("Source and parent must be separate canonical checkout roots");
      if (statSync(input.source).dev !== statSync(parent).dev) throw new Error("Cross-filesystem checkout moves are unsupported; relocate on one filesystem before import");
      checkout = input.source;
    } else {
      lock = openSync(lockPath, "wx", 0o600);
      mkdirSync(journalDir, { recursive: true, mode: 0o700 });
      checkout = join(journalDir, `prepared-${randomUUID()}`);
      git(parent, ["clone", "--no-hardlinks", "--", input.url, checkout]);
    }
    const childGit = standalone(checkout);
    if (git(checkout, ["ls-files", "--stage"]).split("\n").some(l => l.startsWith("160000 "))) throw new Error("Nested submodule relocation is unsupported; its owning checkout must supply a relocation plan");
    const origin = git(checkout, ["remote", "get-url", "origin"]);
    importSource(origin, parent);
    plan.url = origin;
    const manifestBefore = snapshot(join(checkout, ".project.json"));
    const manifest = manifestBefore.bytes === undefined ? { project_id: normalizeProjectId(name), project_name: name, agents: {} } : (await readManifest(manifestBefore.path)).manifest;
    const id = normalizeProjectId(manifest.project_id);
    if (manifest.project_id !== id || manifest.project_slug) throw new Error("Import requires a canonical project_id manifest; migrate legacy identity before relocation");
    plan.projectId = id;
    collision(indexBefore, id, checkout, target);
    await ownedCapabilities(checkout, manifest, home);
    plan.bindings = linkPlan(checkout, target, home, input.mode === "local", options.bindingsHome !== undefined);
    plan.changes.push(`Preserve project_id ${id}, board, agent/profile names and memory values; set repo_path to ${target}`, ...plan.bindings.map(l => `Rebind ${l.path}: ${l.before} -> ${l.after}`));
    if (options.dryRun) return { ok: true, status: "planned", plan };
    if (lock === undefined) lock = openSync(lockPath, "wx", 0o600);
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const gmBefore = snapshot(join(parent, ".gitmodules")), configBefore = snapshot(join(parentGit.gitDir, "config"));
    const alternate = join(journalDir, `index-${randomUUID()}`), modulesTemp = join(journalDir, `modules-${randomUUID()}`);
    let gmExpected = gmBefore, configExpected = configBefore, indexExpected = parentGit.index;
    let manifestExpected: Snapshot | undefined;
    let moved = false, registryAttempted = false;
    const changedLinks: LinkChange[] = [];
    const state: any = { status: "preparing", plan, checkout, phases: [], recovery: "Preserve the checkout and this receipt. Compare parent index/.gitmodules and registry manifest paths before retrying an interrupted import." };
    const save = () => atomic(receiptPath!, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    save();
    try {
      if (!matches(parentGit.index) || !matches(configBefore) || !matches(gmBefore) || !matches(manifestBefore) || !matches(childGit.index) || git(checkout, ["rev-parse", "HEAD"]) !== childGit.head) throw new Error("Concurrent writer changed the import plan; re-plan before moving");
      for (const l of plan.bindings) if (!lstatSync(l.path).isSymbolicLink() || readlinkSync(l.path) !== l.before) throw new Error(`Concurrent binding writer changed ${l.path}`);
      if (present(target)) throw new Error(`Destination collision appeared at ${target}`);
      renameSync(checkout, target); moved = true; state.checkout = target; state.status = "moving"; state.phases.push("move"); save();
      const newManifestPath = join(target, ".project.json");
      if (!matches({ ...manifestBefore, path: newManifestPath })) throw new Error("Concurrent manifest writer changed the moved checkout; preserve it");
      atomic(newManifestPath, `${JSON.stringify({ ...manifest, repo_path: target }, null, 2)}\n`, manifestBefore.mode);
      manifestExpected = snapshot(newManifestPath);
      for (const l of plan.bindings) {
        const path = l.inside ? mapped(l.path, checkout, target) : l.path;
        if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== l.before) throw new Error(`Concurrent binding writer changed ${path}`);
        replaceLink(path, l.before, l.after); changedLinks.push(l);
      }
      state.phases.push("bindings"); save();
      writeFileSync(modulesTemp, gmBefore.bytes ?? "", { mode: gmBefore.mode ?? 0o644 });
      git(parent, ["config", "--file", modulesTemp, `submodule.${name}.path`, name]);
      git(parent, ["config", "--file", modulesTemp, `submodule.${name}.url`, origin]);
      const modulesBytes = readFileSync(modulesTemp);
      writeFileSync(alternate, parentGit.index.bytes!);
      const altEnv = { GIT_INDEX_FILE: alternate };
      const object = git(parent, ["hash-object", "-w", "--stdin"], {}, modulesBytes.toString());
      git(parent, ["update-index", "--add", "--cacheinfo", `100644,${object},.gitmodules`], altEnv);
      git(parent, ["update-index", "--add", "--cacheinfo", `160000,${childGit.head},${name}`], altEnv);
      if (!matches(gmBefore) || !matches(configBefore)) throw new Error("Concurrent parent configuration writer; enrollment refused");
      atomic(gmBefore.path, modulesBytes, gmBefore.mode); gmExpected = snapshot(gmBefore.path);
      git(parent, ["config", `submodule.${name}.url`, origin]); configExpected = snapshot(configBefore.path);
      git(parent, ["config", `submodule.${name}.active`, "true"]); configExpected = snapshot(configBefore.path);
      if (input.mode === "local") { git(parent, ["config", "--local", sourceKey(name), input.source]); configExpected = snapshot(configBefore.path); }
      const indexLock = `${parentGit.index.path}.lock`;
      const fd = openSync(indexLock, "wx", parentGit.index.mode ?? 0o644);
      try {
        if (!matches(parentGit.index)) throw new Error("Concurrent parent index writer; enrollment refused");
        writeFileSync(fd, readFileSync(alternate));
        closeSync(fd); renameSync(indexLock, parentGit.index.path);
      } catch (error) { try { closeSync(fd); } catch {} if (present(indexLock)) unlinkSync(indexLock); throw error; }
      indexExpected = snapshot(parentGit.index.path);
      state.phases.push("submodule"); state.status = "enrolling"; save();
      registryAttempted = true;
      registryRequest(registry, "POST", "/v1/index", { manifest_path: newManifestPath });
      const enrolled = inspect(registry);
      if (enrolled.__registry_status[id]?.manifest_path !== newManifestPath) throw new Error("Registry did not confirm the canonical imported manifest");
      if (!matches({ ...childGit.index, path: join(target, ".git", "index") })) throw new Error("Child index changed during import");
      if (git(target, ["rev-parse", "HEAD"]) !== childGit.head || git(target, ["remote", "get-url", "origin"]) !== origin) throw new Error("Child HEAD/origin changed during import");
      state.phases.push("registry"); state.status = "imported"; save();
      return { ok: true, status: "imported", plan };
    } catch (error) {
      const errors: string[] = [];
      const attempt = (action: () => void) => { try { action(); } catch (e) { errors.push(message(e)); } };
      attempt(() => restore(parentGit.index, indexExpected));
      attempt(() => restore(configBefore, configExpected));
      attempt(() => restore(gmBefore, gmExpected));
      for (const l of changedLinks.reverse()) attempt(() => {
        const path = l.inside ? mapped(l.path, checkout!, target) : l.path;
        if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== l.after) throw new Error(`Concurrent binding writer changed ${path}; preserve it`);
        replaceLink(path, l.after, l.before);
      });
      if (manifestExpected) attempt(() => restore({ ...manifestBefore, path: join(target, ".project.json") }, manifestExpected!));
      if (moved) attempt(() => { if (present(checkout!)) throw new Error(`Recovery source collision: ${checkout}`); renameSync(target, checkout!); moved = false; });
      if (registryAttempted) attempt(() => {
        const indexed = inspect(registry).__registry_status[id];
        const current = indexed?.manifest_path;
        if (current && current !== join(target, ".project.json") && current !== join(checkout!, ".project.json")) throw new Error("Concurrent registry relocation; preserve it and recover manually");
        const old = indexBefore.__registry_status[id];
        if (old) {
          if (current !== old.manifest_path || indexed?.content_hash !== old.content_hash) registryRequest(registry, "POST", "/v1/index", { manifest_path: join(checkout!, ".project.json") });
        }
        else if (current) registryRequest(registry, "POST", "/v1/remove", { project_id: id });
      });
      const rolledBack = errors.length === 0;
      state.status = rolledBack ? "rolled_back" : "recovery_required"; state.error = message(error); state.rollbackErrors = errors; state.checkout = moved ? target : checkout; save();
      return { ok: false, status: state.status, plan, error: message(error), recovery: { receipt: receiptPath, checkout: state.checkout, errors, instructions: rolledBack ? ["Original checkout and parent enrollment restored; retry after fixing the reported cause", ...(input.mode === "remote" ? [`Prepared remote checkout retained at ${checkout}`] : [])] : [state.recovery] } };
    } finally { if (present(alternate)) unlinkSync(alternate); if (present(modulesTemp)) unlinkSync(modulesTemp); }
  } catch (error) {
    if (checkout && plan?.mode === "remote" && present(checkout)) {
      mkdirSync(dirname(receiptPath!), { recursive: true, mode: 0o700 });
      atomic(receiptPath!, `${JSON.stringify({ status: "recovery_required", plan, checkout, error: message(error) }, null, 2)}\n`, 0o600);
      return { ok: false, status: "recovery_required", plan, error: message(error), recovery: { receipt: receiptPath!, checkout, errors: [], instructions: ["Prepared remote checkout retained; resolve the reported capability and review this receipt before retrying"] } };
    }
    return { ok: false, status: "refused", plan, error: message(error), ...(error instanceof Refusal ? { recovery: { checkout: error.checkout, instructions: error.instructions, errors: [] } } : {}) };
  } finally {
    if (lock !== undefined) { closeSync(lock); if (lockPath && present(lockPath)) unlinkSync(lockPath); }
  }
}
