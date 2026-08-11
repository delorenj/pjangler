export interface SupportedCli {
  id: "claude" | "codex" | "gemini" | "copilot" | "opencode" | "kimi";
  name: "Claude" | "Codex" | "Gemini" | "Copilot" | "OpenCode" | "Kimi";
  bmadTool: "claude-code" | "codex" | "gemini" | "github-copilot" | "opencode" | "kimi-code";
  projectRoot: ".claude" | ".codex" | ".gemini" | ".copilot" | ".opencode" | ".kimi-code";
  skillsRoot: string;
}

/** The complete, ordered CLI projection policy. No other CLI is generated. */
export const SUPPORTED_CLIS: readonly SupportedCli[] = Object.freeze([
  { id: "claude", name: "Claude", bmadTool: "claude-code", projectRoot: ".claude", skillsRoot: ".claude/skills" },
  { id: "codex", name: "Codex", bmadTool: "codex", projectRoot: ".codex", skillsRoot: ".codex/skills" },
  { id: "gemini", name: "Gemini", bmadTool: "gemini", projectRoot: ".gemini", skillsRoot: ".gemini/skills" },
  { id: "copilot", name: "Copilot", bmadTool: "github-copilot", projectRoot: ".copilot", skillsRoot: ".copilot/skills" },
  { id: "opencode", name: "OpenCode", bmadTool: "opencode", projectRoot: ".opencode", skillsRoot: ".opencode/skills" },
  { id: "kimi", name: "Kimi", bmadTool: "kimi-code", projectRoot: ".kimi-code", skillsRoot: ".kimi-code/skills" },
]);

export const SUPPORTED_BMAD_TOOLS = SUPPORTED_CLIS.map((cli) => cli.bmadTool);
export const SUPPORTED_CLI_ROOTS = SUPPORTED_CLIS.map((cli) => cli.projectRoot);
