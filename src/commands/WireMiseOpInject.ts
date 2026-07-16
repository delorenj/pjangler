import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class WireMiseOpInject extends Command {
  private static MARKER = "# pjangler:op-inject";
  private static CR = "{{config_root}}";

  async invoke(): Promise<InvokeResult> {
    const scriptPath = ".mise/scripts/inject-op-secrets.sh";
    const fullScriptPath = join(this.context.targetDir, scriptPath);

    const scriptContent = `#!/usr/bin/env bash
# Resolve 1Password \`op://\` references in .env.op into .env.secrets, which mise
# loads via \`_.file\`.
#
# Runs from the mise enter hook: fail-open and non-interactive.
# No .env.op means no 1Password, so this exits before spending anything.

set -euo pipefail

REPO_ROOT="\${MISE_PROJECT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$REPO_ROOT/.env.op"
OUT="$REPO_ROOT/.env.secrets"

TTL_HOURS="\${OP_INJECT_TTL_HOURS:-12}"

[[ -f "$SRC" ]] || exit 0
command -v op >/dev/null 2>&1 || exit 0

if [[ -f "$OUT" && "$SRC" -ot "$OUT" ]]; then
  if [[ "$TTL_HOURS" != "0" ]] && [[ -z "$(find "$OUT" -mmin "+$((TTL_HOURS * 60))" 2>/dev/null)" ]]; then
    exit 0
  fi
fi

op account list >/dev/null 2>&1 || exit 0

tmp="$(mktemp "\${OUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

if op inject -i "$SRC" -o "$tmp" --force >/dev/null 2>&1; then
  mv "$tmp" "$OUT"
  trap - EXIT
else
  echo "mise: op inject from .env.op failed — $(basename "$OUT") unchanged." >&2
  echo "      Check 'op signin', or that .env.op's op:// items are readable." >&2
  echo "      To disable: rm .env.op" >&2
fi
`;

    this.writeFile(scriptPath, scriptContent);
    if (!this.context.dryRun) {
      chmodSync(fullScriptPath, 0o755);
    }

    const misePath = join(this.context.targetDir, "mise.toml");
    if (!existsSync(misePath)) {
      return {
        success: false,
        message: "⚠️  No mise.toml found — run `pj init mise` first, then re-run.",
      };
    }

    let content = readFileSync(misePath, "utf8");
    if (content.includes(WireMiseOpInject.MARKER)) {
      return { success: true, message: this.formatMessage("✓ mise.toml already wired for op-inject") };
    }

    const cr = WireMiseOpInject.CR;

    // 1. Add to _.file in [env]
    const envRe = /\[env\]\s*\n([\s\S]*?(?=\n\[|$))/;
    if (envRe.test(content)) {
      content = content.replace(envRe, (m) => {
        let block = m;
        if (!block.includes("_.file")) {
          block += `\n_.file = ['.env', '.env.secrets']\n`;
        } else if (!block.includes(".env.secrets")) {
          // Replace _.file = [...] with one including .env.secrets
          block = block.replace(/(_\.file\s*=\s*\[)([^\]]*?)(\])/, (m2, prefix, files, suffix) => {
            const added = files.trim() ? `${files}, '.env.secrets'` : `'.env.secrets'`;
            return `${prefix}${added}${suffix}`;
          });
        }
        return block;
      });
    } else {
      // Add [env] block at the top if no tools block, or after tools block
      const envBlock = `[env]\n_.file = ['.env', '.env.secrets']\n\n`;
      if (content.includes("[tools]")) {
        content = content.replace(/(\[tools\][\s\S]*?(?=\n\[|$))/, `$1\n${envBlock}`);
      } else {
        content = envBlock + content;
      }
    }

    // 2. Add to [hooks] enter
    const enterAdds = `  '${cr}/.mise/scripts/inject-op-secrets.sh',`;
    const enterRe = /(enter\s*=\s*\[[\s\S]*?)(\n[ \t]*\])/;
    if (enterRe.test(content)) {
      content = content.replace(enterRe, (_m, head, close) => {
        const sep = /[,[]\s*$/.test(head) ? "" : ",";
        return `${head}${sep}\n${enterAdds}${close}`;
      });
    } else {
      // Add [hooks] block
      if (content.includes("[hooks]")) {
        content = content.replace(/\[hooks\]/, `[hooks]\nenter = [\n${enterAdds}\n]`);
      } else {
        content += `\n[hooks]\nenter = [\n${enterAdds}\n]\n`;
      }
    }

    // 3. Add task
    const appended = [
      "",
      WireMiseOpInject.MARKER,
      "[tasks.secrets-inject]",
      'description = "Re-resolve .env.op secrets from 1Password into .env.secrets"',
      `run = "OP_INJECT_TTL_HOURS=0 .mise/scripts/inject-op-secrets.sh"`,
      WireMiseOpInject.MARKER + ":end",
      "",
    ].join("\n");
    content = content.replace(/\n*$/, "\n") + appended;

    if (!this.context.dryRun) writeFileSync(misePath, content);

    return {
      success: true,
      message: this.formatMessage("✅ Wired mise.toml for op-inject (_.file, [hooks] enter, tasks.secrets-inject)"),
    };
  }
}
