import { basename } from "node:path";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

interface OnboardingPromptArgs {
  component: string;
  output: string;
}

export class OnboardingPrompt extends Command {
  async invoke(): Promise<InvokeResult> {
    const parsed = this.parseArgs();
    if (!parsed.success) {
      return parsed;
    }

    const { component, output } = parsed.value;

    if (this.fileExists(output) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage(`⚠️  ${output} already exists (use --force to overwrite)`),
        filePath: output,
      };
    }

    const prompt = this.buildPrompt(component);
    this.writeFile(output, prompt);

    return {
      success: true,
      message: this.formatMessage(
        this.context.dryRun
          ? `Would create ${output}`
          : `✅ Created ${output}`,
      ),
      filePath: output,
    };
  }

  private parseArgs(): { success: true; value: OnboardingPromptArgs } | InvokeResult {
    const componentRaw = this.context.args?.component;
    const outputRaw = this.context.args?.output;

    const component = typeof componentRaw === "string" && componentRaw.trim().length > 0
      ? componentRaw.trim()
      : basename(this.context.targetDir);

    const output = typeof outputRaw === "string" && outputRaw.trim().length > 0
      ? outputRaw.trim()
      : "ONBOARDING_PROMPT.md";

    return {
      success: true,
      value: {
        component,
        output,
      },
    };
  }

  private buildPrompt(component: string): string {
    return `# ${component} onboarding prompt

Copy/paste this into your coding assistant for a clean bootstrap pass.

---

You are onboarding the repository **${component}** into the 33GOD mise workflow.

## Objective
Set up a clean, repeatable task surface so this repo is consistent with the rest of the infra stack.

## Required outcomes
1. Ensure task runner scaffolding exists and is wired:
   - \`mise.toml\`
   - \`.mise/tasks/base.toml\`
   - \`.mise/tasks/scripts/base.py\`
2. If this repo is a meta/delegator repo, also ensure:
   - \`components.toml\`
   - \`.mise/tasks/console.py\`
3. Keep existing repo behavior intact (do not break existing task names).
4. Do not place secrets into tracked files.
5. End with a concise validation report and exact commands used.

## Execution plan
1. Run scaffold in this repo root:
   - \`pjangler init misebase --force\`
2. Validate with:
   - \`pjangler run doctor\`
3. Show task surface and confirm expected commands:
   - \`mise tasks\`
4. If anything fails, patch minimally and re-run validation.

## Deliverable format
- **Changes made** (bullets)
- **Validation output** (pass/fail with command snippets)
- **Follow-up TODOs** (if any)

---

Quick local shortcut:

\`pjangler run onboarding-prompt --force\`
`;
  }
}
