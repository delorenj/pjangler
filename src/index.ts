#!/usr/bin/env bun
import { Command } from "commander";
import { MiseRecipe } from "./recipes/MiseRecipe";
import { DockerRecipe } from "./recipes/DockerRecipe";
import { NodeRecipe } from "./recipes/NodeRecipe";
import type { CommandContext } from "./commands/Command";

const program = new Command();

program
  .name("pjangler")
  .description("Project subsystem bootstrapper CLI")
  .version("1.0.0");

program
  .command("init")
  .argument("<subsystem>", "Subsystem to initialize")
  .description("Initialize a project subsystem")
  .action(async (subsystem: string) => {
    const context: CommandContext = {
      targetDir: process.cwd(),
      force: false
    };
    
    try {
      switch (subsystem) {
        case "mise":
          const miseRecipe = new MiseRecipe(context);
          await miseRecipe.execute();
          break;
        case "docker":
          const dockerRecipe = new DockerRecipe(context);
          await dockerRecipe.execute();
          break;
        case "node":
          const nodeRecipe = new NodeRecipe(context);
          await nodeRecipe.execute();
          break;
        default:
          console.error(`❌ Unknown subsystem: ${subsystem}`);
          console.log("Available subsystems: mise, docker, node");
          process.exit(1);
      }
    } catch (error) {
      console.error(`❌ Error initializing ${subsystem}:`, error);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List available subsystems")
  .action(() => {
    console.log("Available subsystems:");
    console.log("  mise    - Mise task runner and environment setup");
    console.log("  docker  - Docker containerization setup");
    console.log("  node    - Node.js project template");
    console.log("");
    console.log("Usage examples:");
    console.log("  pjangler init mise");
    console.log("  pjangler init docker");
    console.log("  pjangler init node");
  });

program.parse();