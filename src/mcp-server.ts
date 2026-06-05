#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRecipe, getRecipeInfo, getRecipeNames, COMMAND_REGISTRY, RECIPE_REGISTRY } from "./utils/registry";
import type { CommandContext } from "./commands/Command";
import type { HermesAgentContext } from "./commands/hermes/types";

const server = new McpServer({
  name: "pjangler-mcp",
  version: "1.0.0",
});

function resolveTargetDir(targetDir?: string): string {
  const dir = resolve(targetDir ?? process.cwd());
  if (!existsSync(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
  return dir;
}

async function runRecipeWithCapture(recipeName: string, context: CommandContext): Promise<{ success: boolean; logs: string[]; errors: string[] }> {
  const recipe = createRecipe(recipeName, context);
  if (!recipe) {
    return {
      success: false,
      logs: [],
      errors: [`Unknown recipe: ${recipeName}. Available: ${getRecipeNames().join(", ")}`],
    };
  }

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };

  try {
    await recipe.execute();
    const combined = [...logs, ...errors].join("\n");
    const success = !combined.match(/(^|\n)✗/);
    return { success, logs, errors };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { success: false, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

server.registerTool(
  "pjangler_list_capabilities",
  {
    title: "List pjangler capabilities",
    description: "Returns available recipes and commands exposed by pjangler.",
    inputSchema: {},
  },
  async () => {
    const payload = {
      recipes: Object.values(RECIPE_REGISTRY).map((r) => ({
        name: r.name,
        description: r.description,
        commands: r.commands,
      })),
      commands: Object.values(COMMAND_REGISTRY).map((c) => ({
        name: c.name,
        description: c.description,
        group: c.group,
      })),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }
);

server.registerTool(
  "pjangler_describe_recipe",
  {
    title: "Describe recipe",
    description: "Returns metadata for a specific pjangler recipe.",
    inputSchema: {
      recipe: z.string(),
    },
  },
  async ({ recipe }) => {
    const info = getRecipeInfo(recipe);
    if (!info) {
      return {
        isError: true,
        content: [{ type: "text", text: `Recipe not found: ${recipe}` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: info.name,
              description: info.description,
              commands: info.commands,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "pjangler_run_recipe",
  {
    title: "Run recipe",
    description: "Executes any pjangler recipe against a target directory.",
    inputSchema: {
      recipe: z.enum(getRecipeNames() as [string, ...string[]]),
      targetDir: z.string().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ recipe, targetDir, force, dryRun }) => {
    try {
      const resolvedTarget = resolveTargetDir(targetDir);
      const context: CommandContext = {
        targetDir: resolvedTarget,
        force: force ?? false,
        dryRun: dryRun ?? false,
      };

      const result = await runRecipeWithCapture(recipe, context);
      return {
        isError: !result.success,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                recipe,
                targetDir: resolvedTarget,
                logs: result.logs,
                errors: result.errors,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

server.registerTool(
  "pjangler_deploy_hermes_agent",
  {
    title: "Deploy Hermes agent",
    description:
      "Provision a Hermes agent role with an inherited named profile and optional integrations (Telegram, email, runtime repo, Plane, Bloodbank, systemd).",
    inputSchema: {
      targetDir: z.string(),
      targetRepo: z.string(),
      role: z.string(),
      agentPurpose: z.string().optional(),
      soulTone: z.enum(["direct", "playful", "formal", "terse"]).optional(),
      modelProvider: z.string().optional(),
      modelName: z.string().optional(),
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      skipTelegram: z.boolean().optional(),
      skipEmail: z.boolean().optional(),
      skipRuntimeRepo: z.boolean().optional(),
      skipPlane: z.boolean().optional(),
      skipBloodbank: z.boolean().optional(),
      skipSystemd: z.boolean().optional(),
    },
  },
  async (input) => {
    try {
      const resolvedTarget = resolveTargetDir(input.targetDir);

      const context: HermesAgentContext = {
        targetDir: resolvedTarget,
        yes: true,
        targetRepo: input.targetRepo,
        role: input.role,
        agentPurpose: input.agentPurpose,
        soulTone: input.soulTone,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        force: input.force ?? false,
        dryRun: input.dryRun ?? false,
        skipTelegram: input.skipTelegram ?? true,
        skipEmail: input.skipEmail ?? true,
        skipRuntimeRepo: input.skipRuntimeRepo ?? false,
        skipPlane: input.skipPlane ?? false,
        skipBloodbank: input.skipBloodbank ?? false,
        skipSystemd: input.skipSystemd ?? false,
      };

      const result = await runRecipeWithCapture("hermes-agent", context);
      return {
        isError: !result.success,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                recipe: "hermes-agent",
                targetDir: resolvedTarget,
                context: {
                  targetRepo: context.targetRepo,
                  role: context.role,
                  dryRun: context.dryRun,
                  force: context.force,
                  skipTelegram: context.skipTelegram,
                  skipEmail: context.skipEmail,
                  skipRuntimeRepo: context.skipRuntimeRepo,
                  skipPlane: context.skipPlane,
                  skipBloodbank: context.skipBloodbank,
                  skipSystemd: context.skipSystemd,
                },
                logs: result.logs,
                errors: result.errors,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
