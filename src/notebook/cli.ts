import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { loadProjectRegistry, projectRegistryPath } from "../project/index";
import { runCaptureWorker } from "./capture";
import { readHookPayload, runSessionCloseHook, runSessionStartHook } from "./hooks";
import { migrateNotebook } from "./migration";
import { NotebookModule } from "./module";
import {
  failureEnvelope,
  notebookEnvelopeExitCode,
  normalizeNotebookError,
  renderNotebookJson,
  successEnvelope,
  validateNotebookEnvelope,
} from "./output";
import { notebookStateRoot, statePathForReceipt } from "./state";
import {
  DEFAULT_NOTEBOOK_LIMITS,
  NOTEBOOK_SCHEMA_VERSION,
  NotebookError,
  type EffectiveNotebookConfigV1,
  type NotebookEnvelopeV1,
  type NotebookHealth,
} from "./types";

interface CommonOptions { json?: boolean }

function fallbackConfig(repo: string): EffectiveNotebookConfigV1 {
  return {
    schema_version: 1,
    project_slug: "unknown",
    repo_path: resolve(repo),
    base_url: null,
    auth: { mode: "none" },
    policy: { enabled: false, session_start_enabled: false, session_capture_enabled: false, overview_max_chars: 4_000, documentation_globs: ["**/*.md", "**/*.mdx"] },
    limits: { ...DEFAULT_NOTEBOOK_LIMITS },
    binding: { state: "planned" },
    configuration_provenance: {},
  };
}

function humanValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function emit<T>(envelope: NotebookEnvelopeV1<T>, json: boolean): void {
  validateNotebookEnvelope(envelope);
  if (json) process.stdout.write(renderNotebookJson(envelope));
  else if (envelope.ok) process.stdout.write(`${humanValue(envelope.data)}\n`);
  else process.stderr.write(`notebook: ${envelope.error!.code}: ${envelope.error!.message}\n`);
  process.exitCode = notebookEnvelopeExitCode(envelope);
}

async function execute<T>(input: {
  command: string;
  repo: string;
  json: boolean;
  module: NotebookModule;
  run: () => Promise<{ config: EffectiveNotebookConfigV1; data: T; health?: NotebookHealth }> | { config: EffectiveNotebookConfigV1; data: T; health?: NotebookHealth };
}): Promise<void> {
  try {
    const result = await input.run();
    emit(successEnvelope(input.command, result.config, result.data, result.health ?? null), input.json);
  } catch (error) {
    let config: EffectiveNotebookConfigV1;
    try { config = input.module.context(input.repo, false).config; } catch { config = fallbackConfig(input.repo); }
    emit(failureEnvelope(input.command, config, error), input.json);
  }
}

function readBoundedRegularFile(path: string, maxBytes: number): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new NotebookError("INVALID_INPUT", `File not found: ${absolute}`);
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new NotebookError("INVALID_INPUT", `File must be a regular non-symlink: ${absolute}`);
  if (before.size > maxBytes) throw new NotebookError("INVALID_INPUT", `File exceeds the configured ceiling: ${absolute}`);
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new NotebookError("INVALID_INPUT", `File changed while opening: ${absolute}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8_192, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new NotebookError("INVALID_INPUT", `File exceeds the configured ceiling: ${absolute}`);
      chunks.push(chunk.subarray(0, count));
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { throw new NotebookError("INVALID_INPUT", `File must be valid UTF-8: ${absolute}`); }
  } finally { closeSync(fd); }
}

function textInput(options: { text?: string; file?: string }, maxBytes: number): string {
  if ((options.text !== undefined) === (options.file !== undefined)) throw new NotebookError("INVALID_INPUT", "Exactly one of --text or --file is required");
  if (options.text !== undefined) {
    if (Buffer.byteLength(options.text, "utf8") > maxBytes) throw new NotebookError("INVALID_INPUT", "Text exceeds the configured ceiling");
    return options.text;
  }
  return readBoundedRegularFile(options.file!, maxBytes);
}

async function confirmDelete(noteId: string, options: { yes?: boolean; json?: boolean }): Promise<boolean> {
  if (options.yes) return true;
  if (options.json || !process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await prompt.question(`Delete note ${noteId}? Type yes to continue: `)).trim().toLowerCase() === "yes"; }
  finally { prompt.close(); }
}

export function registerNotebookCli(program: Command, module = new NotebookModule()): void {
  const notebook = program.command("notebook").description("Manage the repository companion notebook");

  notebook.command("status")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--local-only", "Do not construct or contact the remote adapter")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { localOnly?: boolean }) => execute({
      command: "notebook.status", repo, json: Boolean(options.json), module,
      run: async () => { const result = await module.status(repo, Boolean(options.localOnly)); return { config: result.config, data: result.data, health: result.health }; },
    }));

  notebook.command("create")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--live", "Authorize the composite remote reconciliation")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { live: boolean }) => execute({
      command: "notebook.create", repo, json: Boolean(options.json), module,
      run: async () => { const result = await module.create(repo, Boolean(options.live)); return { config: result.config, data: result.data, health: result.health }; },
    }));

  const list = notebook.command("list").description("List notebook resources");
  list.command("notes")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--limit <n>", "Page size", (value) => Number(value), 50)
    .option("--cursor <value>", "Opaque page cursor")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { limit: number; cursor?: string }) => execute({
      command: "notebook.notes.list", repo, json: Boolean(options.json), module,
      run: () => module.listNotes(repo, options.limit, options.cursor),
    }));

  const add = notebook.command("add").description("Add notebook resources");
  add.command("note")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--title <text>", "Note title")
    .option("--text <text>", "Note body")
    .option("--file <path>", "Read note body from a regular file")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { title?: string; text?: string; file?: string }) => execute({
      command: "notebook.notes.add", repo, json: Boolean(options.json), module,
      run: () => {
        if (options.title === undefined) throw new NotebookError("INVALID_INPUT", "--title is required");
        return module.addNote(repo, options.title, textInput(options, module.context(repo, false).config.limits.note_max_bytes));
      },
    }));

  const get = notebook.command("get").description("Get notebook resources");
  get.command("note")
    .argument("<note-id>", "Stable note ID")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--json", "Emit JSON v1")
    .action(async (noteId: string, repo: string, options: CommonOptions) => execute({ command: "notebook.notes.get", repo, json: Boolean(options.json), module, run: () => module.getNote(repo, noteId) }));

  const update = notebook.command("update").description("Update notebook resources");
  update.command("note")
    .argument("<note-id>", "Stable note ID")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--title <text>", "Replacement title")
    .option("--text <text>", "Replacement body")
    .option("--file <path>", "Read replacement body from a regular file")
    .option("--json", "Emit JSON v1")
    .action(async (noteId: string, repo: string, options: CommonOptions & { title?: string; text?: string; file?: string }) => execute({
      command: "notebook.notes.update", repo, json: Boolean(options.json), module,
      run: () => module.updateNote(repo, noteId, { title: options.title, text: textInput(options, module.context(repo, false).config.limits.note_max_bytes) }),
    }));

  const remove = notebook.command("delete").description("Delete notebook resources");
  remove.command("note")
    .argument("<note-id>", "Stable note ID")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--yes", "Confirm deletion")
    .option("--json", "Emit JSON v1")
    .action(async (noteId: string, repo: string, options: CommonOptions & { yes?: boolean }) => execute({
      command: "notebook.notes.delete", repo, json: Boolean(options.json), module,
      run: async () => module.deleteNote(repo, noteId, await confirmDelete(noteId, options)),
    }));

  const search = notebook.command("search").description("Search scoped notebook resources locally");
  search.command("notes")
    .argument("<query>", "Required all-token text query")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--limit <n>", "Result limit", (value) => Number(value), 20)
    .option("--json", "Emit JSON v1")
    .action(async (query: string, repo: string, options: CommonOptions & { limit: number }) => execute({ command: "notebook.notes.search", repo, json: Boolean(options.json), module, run: () => module.searchNotes(repo, query, options.limit) }));

  notebook.command("overview")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--set-file <path>", "Replace Overview body from a regular file")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { setFile?: string }) => execute({
      command: options.setFile ? "notebook.overview.set" : "notebook.overview.get", repo, json: Boolean(options.json), module,
      run: () => module.overview(repo, options.setFile ? readBoundedRegularFile(options.setFile, module.context(repo, false).config.limits.note_max_bytes) : undefined),
    }));

  const capture = notebook.command("capture").description("Inspect and retry durable capture receipts");
  capture.command("list")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--state <value>", "Filter by exact receipt state")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { state?: string }) => execute({ command: "notebook.capture.list", repo, json: Boolean(options.json), module, run: () => module.captureList(repo, options.state) }));
  capture.command("retry")
    .argument("<receipt-id>", "Durable receipt ID")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--baseline <git-ref>", "Explicit committed baseline for blocked-missing-baseline")
    .option("--json", "Emit JSON v1")
    .action(async (receiptId: string, repo: string, options: CommonOptions & { baseline?: string }) => execute({ command: "notebook.capture.retry", repo, json: Boolean(options.json), module, run: () => module.captureRetry(repo, receiptId, options.baseline) }));

  notebook.command("audit")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--local-only", "Do not construct or contact the remote adapter")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { localOnly?: boolean }) => execute({
      command: "notebook.audit", repo, json: Boolean(options.json), module,
      run: async () => { const result = await module.audit(repo, Boolean(options.localOnly)); return { config: result.config, data: result.data, health: result.health }; },
    }));

  notebook.command("migrate")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--apply", "Apply selected owned repairs")
    .option("--live", "Authorize selected remote repairs")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { apply?: boolean; live?: boolean }) => execute({
      command: "notebook.migrate", repo, json: Boolean(options.json), module,
      run: async () => ({ config: module.context(repo, false).config, data: await migrateNotebook(module, repo, { apply: Boolean(options.apply), live: Boolean(options.live) }) }),
    }));

  // PJAN-82: the host skill projection is machine state, so it gets its own
  // command instead of riding on a per-repository migration. Drift here used to
  // surface only as an opaque `pj init` abort with no way to inspect or fix it.
  notebook.command("skill")
    .description("Inspect and reconcile the host Project Notebook skill projection")
    .argument("[repo]", "Registered repository", process.cwd())
    .option("--apply", "Restore the drifted canonical projection from the version-pinned export")
    .option("--json", "Emit JSON v1")
    .action(async (repo: string, options: CommonOptions & { apply?: boolean }) => execute({
      command: "notebook.skill", repo, json: Boolean(options.json), module,
      run: async () => ({ config: module.context(repo, false).config, data: module.repairSkillProjection(Boolean(options.apply)) }),
    }));

  const hook = notebook.command("hook", { hidden: true }).description("Internal managed hook entry points");
  for (const [name, expected] of [["session-start", "SessionStart"], ["session-close", "SessionEnd"]] as const) {
    hook.command(name, { hidden: true })
      .option("--payload-file <path>", "Contained compatibility payload file")
      .action(async (options: { payloadFile?: string }) => {
        try {
          const read = readHookPayload({ payloadFile: options.payloadFile, stateRoot: module.stateRoot, maxBytes: DEFAULT_NOTEBOOK_LIMITS.hook_payload_max_bytes });
          const payload = read.payload;
          const repo = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
          if (repo) {
            const configuredLimit = module.context(repo, false).config.limits.hook_payload_max_bytes;
            if (read.bytes > configuredLimit) throw new NotebookError("INVALID_INPUT", "Hook payload exceeds this project's configured ceiling");
          }
          if (payload.hook_event_name === undefined) payload.hook_event_name = expected;
          const result = name === "session-start" ? await runSessionStartHook(module, payload) : runSessionCloseHook(module, payload);
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(`${result.stderr}\n`);
        } catch (error) {
          process.stderr.write(`project-notebook: hook payload rejected; failed open: ${normalizeNotebookError(error).message.slice(0, 512)}\n`);
        }
        process.exitCode = 0;
      });
  }

  const worker = notebook.command("worker", { hidden: true }).description("Internal detached workers");
  worker.command("capture", { hidden: true })
    .requiredOption("--receipt-id <id>", "Durable receipt ID")
    .action(async (options: { receiptId: string }) => {
      try {
        const registryFile = projectRegistryPath();
        const registry = loadProjectRegistry(registryFile);
        const root = notebookStateRoot();
        const explicit = process.env.PJ_NOTEBOOK_WORKER_PROJECT_SLUG;
        const slug = explicit && registry.projects[explicit]
          ? explicit
          : Object.keys(registry.projects).find((candidate) => existsSync(statePathForReceipt(root, candidate, options.receiptId)));
        if (!slug) throw new NotebookError("NOT_FOUND", "Receipt does not belong to a registered project");
        await runCaptureWorker(new NotebookModule({ registryPath: registryFile, stateRoot: root }), slug, options.receiptId);
      } catch (error) {
        process.stderr.write(`project-notebook worker: ${normalizeNotebookError(error).message.slice(0, 512)}\n`);
        process.exitCode = 6;
      }
    });
}

export function isNotebookJsonInvocation(args: readonly string[]): boolean {
  return args[0] === "notebook" && args.includes("--json");
}

function parserCommand(args: readonly string[]): string {
  const primary = args[1];
  const secondary = args[2];
  if (primary === "status" || primary === "create" || primary === "audit" || primary === "migrate" || primary === "skill") return `notebook.${primary}`;
  if (primary === "overview") return args.includes("--set-file") ? "notebook.overview.set" : "notebook.overview.get";
  if (primary === "list" && secondary === "notes") return "notebook.notes.list";
  if (primary === "add" && secondary === "note") return "notebook.notes.add";
  if (primary === "get" && secondary === "note") return "notebook.notes.get";
  if (primary === "update" && secondary === "note") return "notebook.notes.update";
  if (primary === "delete" && secondary === "note") return "notebook.notes.delete";
  if (primary === "search" && secondary === "notes") return "notebook.notes.search";
  if (primary === "capture" && secondary === "list") return "notebook.capture.list";
  if (primary === "capture" && secondary === "retry") return "notebook.capture.retry";
  return "notebook.status";
}

function parserRepo(args: readonly string[]): string {
  const primary = args[1];
  const secondary = args[2];
  const index = primary === "status" || primary === "create" || primary === "audit" || primary === "migrate" || primary === "overview"
    ? 2
    : (primary === "list" || primary === "add" || (primary === "capture" && secondary === "list")) ? 3 : 4;
  const candidate = args[index];
  return candidate && !candidate.startsWith("-") ? candidate : process.cwd();
}

export function notebookParserFailureEnvelope(args: readonly string[], module = new NotebookModule()): NotebookEnvelopeV1<never> {
  const repo = parserRepo(args);
  let config: EffectiveNotebookConfigV1;
  try { config = module.context(repo, false).config; } catch { config = fallbackConfig(repo); }
  return failureEnvelope(parserCommand(args), config, new NotebookError("INVALID_INPUT", "Invalid notebook command arguments"));
}
