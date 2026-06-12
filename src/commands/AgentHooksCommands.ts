import type { InvokeResult } from "./Command";
import { Command } from "./Command";

/**
 * Resolve the CommonProject copier template root (which vendors the generic
 * agent-hooks tree). The installed pjangler `dist/` does not ship templates, so
 * we resolve against, in order: an env override, the source-tree layout, and the
 * canonical ~/code/pjangler checkout.
 */
function resolveTemplateRoot(): string {
  const { existsSync } = require("fs");
  const { join } = require("path");
  const os = require("os");
  const candidates = [
    process.env.PJANGLER_COMMONPROJECT_TEMPLATE,
    join(__dirname, "..", "..", "templates", "commonproject", "template"),
    join(os.homedir(), "code", "pjangler", "templates", "commonproject", "template"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, ".agents", "hooks", "hooks.master.json"))) return c;
  }
  throw new Error(
    "Could not locate the CommonProject template. Set PJANGLER_COMMONPROJECT_TEMPLATE to <repo>/templates/commonproject/template."
  );
}

/**
 * Copy the generic project-scoped agent-hooks tree (hooks SSOT + sync engine +
 * hindsight scripts + hermes adapter + skill linker + hindsight-setup +
 * local.example.json) from the CommonProject template into the target repo.
 * Files are already project-agnostic (bank = repo basename, op ref is a
 * placeholder), so no rendering is needed.
 */
export class CopyAgentHooksTree extends Command {
  async invoke(): Promise<InvokeResult> {
    const { existsSync, cpSync, mkdirSync } = require("fs");
    const { join } = require("path");

    let templateRoot: string;
    try {
      templateRoot = resolveTemplateRoot();
    } catch (e) {
      return { success: false, message: `⚠️  ${(e as Error).message}` };
    }

    // src(relative) -> dest(relative). Directories are copied recursively.
    const items: Array<{ rel: string; dir: boolean }> = [
      { rel: ".agents/hooks", dir: true },
      { rel: ".agents/local.example.json", dir: false },
      { rel: ".mise/scripts/link-project-skills-to-clis.sh", dir: false },
      { rel: ".mise/scripts/unlink-project-skills-from-clis.sh", dir: false },
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
        const { dirname } = require("path");
        mkdirSync(dirname(dest), { recursive: true });
        // preserves mode (exec bits) and copies recursively for dirs
        cpSync(src, dest, { recursive: dir, force: true });
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
    const { existsSync, readFileSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const misePath = join(this.context.targetDir, "mise.toml");

    if (!existsSync(misePath)) {
      return {
        success: false,
        message: "⚠️  No mise.toml found — run `pjangler init mise` first, then re-run.",
      };
    }
    let content = readFileSync(misePath, "utf8");
    if (content.includes(WireMiseAgentHooks.MARKER)) {
      return { success: true, message: this.formatMessage("✓ mise.toml already wired for agent-hooks") };
    }

    const cr = WireMiseAgentHooks.CR;
    const enterAdds = [
      `  "${cr}/.mise/scripts/link-project-skills-to-clis.sh",`,
      `  "${cr}/.agents/hooks/sync.py --install --quiet",`,
    ].join("\n");
    const leaveBlock = [
      "leave = [",
      `  "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh",`,
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
      // Ensure a leave array too: extend it, or add one right after the [hooks] enter close.
      const leaveRe = /(leave\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
      if (leaveRe.test(content)) {
        content = content.replace(leaveRe, (_m, head, close) => {
          const sep = /[,[]\s*$/.test(head) ? "" : ",";
          return `${head}${sep}\n  "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh",\n  "${cr}/.agents/hooks/sync.py --uninstall --quiet",${close}`;
        });
      } else {
        // add a leave array immediately after the enter array's closing ]
        content = content.replace(enterRe, (m) => `${m}\n${leaveBlock}`);
      }
      wiredHooks = true;
    }

    const appended = [
      "",
      WireMiseAgentHooks.MARKER + " (generated — see .agents/hooks/README.md)",
      "[[watch_files]]",
      'patterns = [".agents/hooks/hooks.master.json"]',
      'task = "hooks-sync"',
      "",
      "[tasks.hooks-sync]",
      'description = "Fan out hooks.master.json to each agent CLI (claude/codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --install"`,
      "",
      "[tasks.hooks-check]",
      'description = "Drift gate: verify generated hook configs match hooks.master.json"',
      `run = "${cr}/.agents/hooks/sync.py --check"`,
      "",
      "[tasks.hooks-uninstall]",
      'description = "Remove per-user agent-hook injections (codex/kimi/hermes)"',
      `run = "${cr}/.agents/hooks/sync.py --uninstall"`,
      "",
      "[tasks.link-project-skills-to-clis]",
      'description = "Fan .agents/skills out to each agent CLI (honors local.json)"',
      `run = "${cr}/.mise/scripts/link-project-skills-to-clis.sh"`,
      "",
      "[tasks.unlink-project-skills-from-clis]",
      'description = "Remove project skill symlinks from shared per-CLI dirs"',
      `run = "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh"`,
      "",
      "[tasks.skills-relink]",
      'description = "Re-fan the project skill set to all CLIs"',
      `run = "${cr}/.mise/scripts/link-project-skills-to-clis.sh"`,
      "",
      "[tasks.hindsight-setup]",
      'description = "Provision this dev\'s shared project Hindsight key from 1Password into .env"',
      `run = "${cr}/.mise/scripts/hindsight-setup.sh"`,
      "",
      WireMiseAgentHooks.MARKER + ":end",
      "",
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;

    if (!this.context.dryRun) writeFileSync(misePath, content);

    if (wiredHooks) {
      return { success: true, message: this.formatMessage("✅ Wired mise.toml ([hooks] enter/leave + tasks)") };
    }
    return {
      success: true,
      message: this.formatMessage(
        "✅ Added agent-hooks tasks to mise.toml.\n" +
          "   ⚠️  Could not find a [hooks].enter array to extend — add these to your [hooks] block manually:\n" +
          `     enter += "${cr}/.mise/scripts/link-project-skills-to-clis.sh", "${cr}/.agents/hooks/sync.py --install --quiet"\n` +
          `     leave += "${cr}/.mise/scripts/unlink-project-skills-from-clis.sh", "${cr}/.agents/hooks/sync.py --uninstall --quiet"`
      ),
    };
  }
}
