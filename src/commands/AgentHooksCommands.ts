import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";
import { resolveAgentHooksLayer } from "../project/index";
import { SKILLS_SYNC_TOOLS } from "../parity/rules";
import { canonicalJson, checkRewrite, deepClone, isTable, type TomlTable } from "../parity/mise-toml";
import { parse as parseToml } from "smol-toml";

/** Shared skip result when a global ~/.agents/hooks install makes the project-scoped
 * layer redundant. Overridable with PJ_AGENT_HOOKS_LAYER=1. */
const AGENT_HOOKS_SKIP_MESSAGE =
  "↷ agent-hooks layer skipped: global ~/.agents/hooks detected (these hooks already run globally).\n" +
  "   Set PJ_AGENT_HOOKS_LAYER=1 to install the project-scoped layer anyway.";

/**
 * Resolve the CommonProject copier template root (which vendors the generic
 * agent-hooks tree under template/.agents/hooks). Walks up from this module's
 * directory so it works both from source (src/commands/) and from the bundled
 * ESM dist (dist/index.js) — the npm package ships templates/ at its root. Falls
 * back to an env override and the canonical ~/code/pjangler checkout.
 */
function resolveTemplateRoot(): string {
  const candidates: string[] = [];
  if (process.env.PJANGLER_COMMONPROJECT_TEMPLATE) {
    candidates.push(process.env.PJANGLER_COMMONPROJECT_TEMPLATE);
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join(dir, "templates", "commonproject", "template"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url unavailable — rely on the other candidates */
  }
  candidates.push(join(homedir(), "code", "pjangler", "templates", "commonproject", "template"));

  for (const c of candidates) {
    if (existsSync(join(c, ".agents", "hooks", "hooks.master.json"))) return c;
  }
  throw new Error(
    "Could not locate the CommonProject template. Set PJANGLER_COMMONPROJECT_TEMPLATE to <repo>/templates/commonproject/template."
  );
}

/**
 * Copy the generic project-scoped agent-hooks tree (hooks SSOT + sync engine +
 * hindsight scripts + hermes adapter + skills manifest + hindsight-setup +
 * local.example.json) from the CommonProject template into the target repo.
 * Files are already project-agnostic (bank = repo basename, op ref is a
 * placeholder), so no rendering is needed.
 */
export class CopyAgentHooksTree extends Command {
  async invoke(): Promise<InvokeResult> {
    if (!resolveAgentHooksLayer()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    let templateRoot: string;
    try {
      templateRoot = resolveTemplateRoot();
    } catch (e) {
      return { success: false, message: `⚠️  ${(e as Error).message}` };
    }

    // relative path -> whether it's a directory (copied recursively)
    const items: Array<{ rel: string; dir: boolean }> = [
      { rel: ".agents/hooks", dir: true },
      { rel: ".agents/skills.json", dir: false },
      { rel: ".agents/local.example.json", dir: false },
      { rel: ".mise/scripts/hindsight-setup.sh", dir: false },
    ];

    const created: string[] = [];
    const skipped: string[] = [];
    for (const { rel, dir } of items) {
      const src = join(templateRoot, rel);
      const dest = join(this.context.targetDir, rel);
      if (!existsSync(src)) continue;
      if (existsSync(dest) && !this.context.force) {
        skipped.push(rel);
        continue;
      }
      if (!this.context.dryRun) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { recursive: dir, force: true }); // preserves mode (exec bits)
      }
      created.push(rel);
    }

    const verb = this.context.dryRun ? "Would copy" : "Copied";
    const tail = skipped.length ? ` (${skipped.length} already present — use --force to overwrite)` : "";
    return {
      success: created.length > 0,
      message: this.formatMessage(`✅ ${verb} ${created.length} agent-hooks path(s)${tail}`),
    };
  }
}

/**
 * Merge the agent-hooks wiring into an existing mise.toml: extend
 * [hooks].enter/leave and append the watch_files + tasks. Idempotent (guarded by
 * a sentinel marker). For the canonical CommonProject layout it edits in place;
 * if it can't find a [hooks].enter array to extend, it appends the tasks and
 * prints the exact enter/leave lines to add by hand (never corrupts the file).
 */
export class WireMiseAgentHooks extends Command {
  private static MARKER = "# pjangler:agent-hooks";
  private static CR = "{{config_root}}"; // mise's own runtime var — emitted literally

  async invoke(): Promise<InvokeResult> {
    if (!resolveAgentHooksLayer()) {
      return { success: true, message: this.formatMessage(AGENT_HOOKS_SKIP_MESSAGE) };
    }
    const misePath = join(this.context.targetDir, "mise.toml");

    if (!existsSync(misePath)) {
      return {
        success: false,
        message: "⚠️  No mise.toml found — run `pj add mise` first, then re-run.",
      };
    }
    let content = readFileSync(misePath, "utf8");
    if (content.includes(WireMiseAgentHooks.MARKER)) {
      return { success: true, message: this.formatMessage("✓ mise.toml already wired for agent-hooks") };
    }
    const original = content;
    let parsedOriginal: TomlTable;
    try {
      parsedOriginal = parseToml(original) as TomlTable;
    } catch (error) {
      return { success: false, message: `⚠️  mise.toml is not valid TOML (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); repair it, then re-run.` };
    }
    const existingTasks = isTable(parsedOriginal.tasks) ? parsedOriginal.tasks : {};

    const cr = WireMiseAgentHooks.CR;
    const enterAdds = `  "${cr}/.agents/hooks/sync.py --install --quiet",`;
    const leaveBlock = [
      "leave = [",
      `  "${cr}/.agents/hooks/sync.py --uninstall --quiet",`,
      "]",
    ].join("\n");

    let wiredHooks = false;
    // Insert our enter lines before the closing ] of an existing `enter = [ ... ]`.
    const enterRe = /(enter\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
    if (enterRe.test(content)) {
      content = content.replace(enterRe, (_m, head, close) => {
        const sep = /[,[]\s*$/.test(head) ? "" : ","; // add a comma only if needed
        return `${head}${sep}\n${enterAdds}${close}`;
      });
      // Ensure a leave array too: extend it, or add one right after the enter close.
      const leaveRe = /(leave\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
      if (leaveRe.test(content)) {
        content = content.replace(leaveRe, (_m, head, close) => {
          const sep = /[,[]\s*$/.test(head) ? "" : ",";
          return `${head}${sep}\n  "${cr}/.agents/hooks/sync.py --uninstall --quiet",${close}`;
        });
      } else {
        content = content.replace(enterRe, (m) => `${m}\n${leaveBlock}`);
      }
      wiredHooks = true;
    }

    const skillsSync = [
      '[tasks."skills:sync"]',
      `description = "Reconcile this project's selected skills"`,
      `tools = ${SKILLS_SYNC_TOOLS}`,
      `run = "skillex sync --scope project --project '${cr}'"`,
      "",
    ];
    // PJAN-135: a project whose parity migrate already wrote the managed
    // skills:sync task keeps it; appending a second table under the same name
    // wrote a mise.toml nothing could parse.
    const managedSkillsSync = (parseToml(skillsSync.join("\n")) as { tasks: TomlTable }).tasks["skills:sync"];
    const keepSkillsSync = existingTasks["skills:sync"] !== undefined
      && canonicalJson(existingTasks["skills:sync"]) === canonicalJson(managedSkillsSync);
    const appended = [
      "",
      WireMiseAgentHooks.MARKER + " (generated — see .agents/hooks/README.md)",
      // PJAN-61: task names use the colon namespace form. A colon is not legal
      // in a BARE toml key, so every header here MUST stay quoted.
      ...(keepSkillsSync ? [] : skillsSync),
      "[[watch_files]]",
      'patterns = [".agents/hooks/hooks.master.json"]',
      'task = "hooks:sync"',
      "",
      '[tasks."hooks:sync"]',
      'description = "Fan out hooks.master.json to each agent CLI (claude/codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --install"`,
      "",
      '[tasks."hooks:check"]',
      'description = "Drift gate: verify generated hook configs match hooks.master.json"',
      `run = "${cr}/.agents/hooks/sync.py --check"`,
      "",
      '[tasks."hooks:uninstall"]',
      'description = "Remove per-user agent-hook injections (codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --uninstall"`,
      "",
      '[tasks."hindsight:setup"]',
      'description = "Provision this dev\'s shared project Hindsight key from 1Password into .env"',
      `run = "${cr}/.mise/scripts/hindsight-setup.sh"`,
      "",
      WireMiseAgentHooks.MARKER + ":end",
      "",
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;

    // PJAN-135: like every mise.toml rewrite, the result must parse and mean
    // the original plus exactly these additions, or nothing is written.
    const expected = deepClone(parsedOriginal);
    const additions = parseToml(appended) as { tasks?: TomlTable; watch_files?: unknown[] };
    expected.tasks = { ...existingTasks, ...(additions.tasks ?? {}) };
    expected.watch_files = [...(Array.isArray(parsedOriginal.watch_files) ? parsedOriginal.watch_files : []), ...(additions.watch_files ?? [])];
    if (wiredHooks) {
      const hooks = isTable(expected.hooks) ? expected.hooks : (expected.hooks = {});
      hooks.enter = [...(Array.isArray(hooks.enter) ? hooks.enter : []), `${cr}/.agents/hooks/sync.py --install --quiet`];
      hooks.leave = [...(Array.isArray(hooks.leave) ? hooks.leave : []), `${cr}/.agents/hooks/sync.py --uninstall --quiet`];
    }
    const verdict = checkRewrite(expected, content);
    if (!verdict.ok) {
      return { success: false, message: `⚠️  mise.toml was not rewritten: ${verdict.reason}. Add the agent-hooks tasks by hand.` };
    }

    if (!this.context.dryRun) writeFileSync(misePath, content);

    if (wiredHooks) {
      return { success: true, message: this.formatMessage("✅ Wired mise.toml ([hooks] enter/leave + tasks)") };
    }
    return {
      success: true,
      message: this.formatMessage(
        "✅ Added agent-hooks tasks to mise.toml.\n" +
          "   ⚠️  Could not find a [hooks].enter array to extend — add these to your [hooks] block manually:\n" +
          `     enter += "${cr}/.agents/hooks/sync.py --install --quiet"\n` +
          `     leave += "${cr}/.agents/hooks/sync.py --uninstall --quiet"`
      ),
    };
  }
}
