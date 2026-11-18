import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolvePjanglerRoot, type ProjectInitPlan } from "./index";

export interface InitPathChange {
  path: string;
  type: "file" | "symlink" | "directory";
  operation: "create" | "modify" | "remove";
}

type Entry = { type: InitPathChange["type"]; fingerprint: string };

/** The inventory is intentionally independent of Git's ignore rules and the lifecycle rollback snapshot. */
function inventory(root: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = relative(root, path).split("\\").join("/");
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.set(key, { type: "directory", fingerprint: "directory" });
        // Git's object database is not project scaffold content. The .git directory itself is.
        if (key !== ".git") walk(path);
      } else if (stat.isSymbolicLink()) {
        entries.set(key, { type: "symlink", fingerprint: readlinkSync(path) });
      } else if (stat.isFile()) {
        entries.set(key, { type: "file", fingerprint: `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mode & 0o7777}` });
      } else {
        throw new Error(`Cannot inventory special filesystem entry: ${path}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}

export function diffInitPaths(before: Map<string, Entry>, after: Map<string, Entry>): InitPathChange[] {
  const result: InitPathChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prior = before.get(path), next = after.get(path);
    if (prior?.type === next?.type && prior?.fingerprint === next?.fingerprint) continue;
    if (prior && prior.type !== next?.type) result.push({ path, type: prior.type, operation: "remove" });
    if (next) result.push({ path, type: next.type, operation: prior?.type === next.type ? "modify" : "create" });
  }
  return result;
}

/**
 * Exercise the actual ProjectRecipe on a disposable copy mounted at the ORIGINAL
 * target path in a read-only, networkless mount namespace. Even hard-coded paths
 * in Copier, parity and installer tasks resolve to the copy. Nothing can write
 * to the real registry, target or operator home. A failed rehearsal is NOT a
 * successful preview: an unmodelled installer must fail closed.
 */
export function previewProjectInit(plan: ProjectInitPlan, mode: "create" | "sync", selectedRuleIds: readonly string[]): InitPathChange[] {
  const target = resolve(plan.project.repo_path);
  const sandbox = mkdtempSync(join(tmpdir(), "pjangler-init-preview-"));
  const home = process.env.HOME;
  if (!home || resolve(home) !== homedir()) throw new Error("Incomplete init preview: consistent HOME is required for isolated rehearsal");
  try {
    const originalRegistry = plan.registryPath;
    if (originalRegistry.startsWith("http:") || originalRegistry.startsWith("https:")) {
      throw new Error("Registry-service inventory cannot be isolated safely; use a local registry snapshot");
    }
    const copy = join(sandbox, "target");
    mkdirSync(copy);
    const before = inventory(target);
    if (existsSync(target)) {
      for (const name of readdirSync(target)) {
        if (name === ".git" && lstatSync(join(target, name)).isDirectory()) {
          const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", "--local", "--", target, join(sandbox, "git-copy")], { encoding: "utf8", timeout: 30_000 });
          if (clone.status !== 0) throw new Error(`Cannot copy git state: ${clone.stderr || clone.error?.message}`);
          cpSync(join(sandbox, "git-copy", ".git"), join(copy, ".git"), { recursive: true, dereference: false, verbatimSymlinks: true });
          continue;
        }
        cpSync(join(target, name), join(copy, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
      }
    }
    mkdirSync(join(sandbox, "home"));
    mkdirSync(join(sandbox, "tmp"));
    if (existsSync(originalRegistry)) cpSync(originalRegistry, join(sandbox, "registry.yaml"));
    const fresh = !existsSync(target);
    const bindAt = fresh ? dirname(target) : target;
    if (fresh) {
      mkdirSync(join(sandbox, "target-parent"));
      mkdirSync(join(sandbox, "target-parent", target.slice(bindAt.length + 1)));
    }
    const shadow = (path: string): string => fresh && resolve(path).startsWith(`${bindAt}/`)
      ? join(sandbox, "target-parent", relative(bindAt, path)) : path;
    // Inputs hidden by the parent bind have to be mirrored into the overlay.
    // Never execute the original installer from a masked parent by mistake.
    const inputs = [process.env.PJ_BMAD_INSTALLER, process.env.SKILLEX_REGISTRY_ROOT,
      process.env.PJ_SKILLS_REGISTRY_ROOT, ...process.env.PATH!.split(":"),
      process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, "pjangler", "bmad-dist-tags.json")]
      .filter((value): value is string => Boolean(value));
    const protectedPaths = [target, originalRegistry, home, sandbox];
    for (const input of inputs) {
      if (input !== process.env.XDG_CACHE_HOME && protectedPaths.some((path) => resolve(input) === resolve(path) || resolve(path).startsWith(`${resolve(input)}${sep}`))) {
        throw new Error(`Cannot safely inventory installer input that contains protected state: ${input}`);
      }
    }
    for (const input of new Set(inputs)) {
      if (!existsSync(input) || shadow(input) === input) continue;
      const destination = shadow(input);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(input, destination, { recursive: true, dereference: false });
    }
    // /tmp is a private, caller-owned namespace root (Skillex checks receipt
    // ancestry). Only explicitly named tool inputs are mirrored into it.
    for (const input of new Set(inputs)) {
      if (!input.startsWith("/tmp/") || !existsSync(input)) continue;
      const destination = join(sandbox, "tmp-inputs", relative("/tmp", input));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(input, destination, { recursive: true, dereference: false });
    }
    const safePlan: ProjectInitPlan = {
      ...plan,
      apply: true,
      dryRun: false,
      live: false,
      registryPath: join(sandbox, "registry.yaml"),
      actions: plan.actions.map((action) => action.kind === "registry.upsert"
        ? { ...action, registryPath: join(sandbox, "registry.yaml") }
        : action.kind === "ticket-provider.create-or-link"
          ? { ...action, enabled: false, live: false, reason: "preview rehearsal: external effects disabled" }
          : action),
    };
    const runner = join(resolvePjanglerRoot(), "dist", "project", "preview-runner.js");
    if (!existsSync(runner)) throw new Error(`Missing preview runner ${runner}; rebuild pjangler`);
    const actualCopy = fresh ? join(sandbox, "target-parent", relative(bindAt, target)) : copy;
    const temporaryPaths = [...new Set([sandbox, bindAt].filter((path) => path.startsWith("/tmp/"))
      .flatMap((path) => {
        const segments = relative("/tmp", path).split("/");
        return segments.map((_, index) => join("/tmp", ...segments.slice(0, index + 1)));
      }))].sort((a, b) => a.length - b.length);
    const tmpInputs = inputs.filter((input) => input.startsWith("/tmp/") && existsSync(input));
    for (const path of tmpInputs) for (let parent = dirname(path); parent.startsWith("/tmp/"); parent = dirname(parent)) {
      if (!temporaryPaths.includes(parent)) temporaryPaths.push(parent);
    }
    temporaryPaths.sort((a, b) => a.length - b.length);
    const args = ["--tmpfs", "/", "--dir", "/home", "--dir", "/home/delorenj", "--dir", "/tmp",
      ...temporaryPaths.flatMap((path) => ["--dir", path]),
      ...["/usr", "/bin", "/lib", "/lib64", "/etc", "/opt"].flatMap((path) => existsSync(path) ? ["--ro-bind", path, path] : []),
      "--ro-bind", "/home/delorenj", "/home/delorenj",
      ...tmpInputs.flatMap((input) => ["--ro-bind", join(sandbox, "tmp-inputs", relative("/tmp", input)), input]),
      "--bind", sandbox, sandbox, "--bind", fresh ? join(sandbox, "target-parent") : copy, bindAt,
      "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--unshare-net",
      "--setenv", "HOME", join(sandbox, "home"), "--setenv", "XDG_CACHE_HOME", join(sandbox, "home", ".cache"),
      "--setenv", "XDG_STATE_HOME", join(sandbox, "home", ".local", "state"), "--setenv", "TMPDIR", join(sandbox, "tmp"),
      "--setenv", "PJ_PROJECT_REGISTRY", join(sandbox, "registry.yaml"),
      "--unsetenv", "PYTHONPATH", "--unsetenv", "PYTHONHOME", "--", process.execPath, runner];
    const child = spawnSync("bwrap", args, {
      input: JSON.stringify({ plan: safePlan, mode, selectedRuleIds }), encoding: "utf8", timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(`Isolated scaffold rehearsal failed: ${(child.stderr || child.stdout || child.error?.message || `exit ${child.status}`).trim()}`);
    let result: { ok: boolean; errors?: string[] };
    try { result = JSON.parse(child.stdout) as typeof result; }
    catch { throw new Error(`Isolated scaffold rehearsal returned invalid output: ${child.stdout.slice(0, 1000)}`); }
    if (!result.ok) throw new Error(`Isolated scaffold rehearsal could not inventory enabled steps: ${result.errors?.join("; ") || "unknown failure"}`);
    return diffInitPaths(before, inventory(actualCopy));
  } catch (error) {
    throw new Error(`Incomplete init preview: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
