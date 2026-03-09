import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { basename } from "node:path";
import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddThirtyThreeGodSkeleton extends Command {
  async invoke(): Promise<InvokeResult> {
    if (this.fileExists("CLAUDE.md") && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  33GOD skeleton files already exist. Use --force to overwrite."),
      };
    }

    const answers = await this.promptUser();
    let planeProjectId = "REPLACE_ME_WITH_UUID";

    const planeApiKey = this.getPlaneApiKey();
    if (planeApiKey) {
      console.log("🏗️  Creating project in Plane...");
      const id = await this.createPlaneProject(answers, planeApiKey);
      if (id) {
        planeProjectId = id;
        console.log(`✅ Created Plane Project! ID: ${planeProjectId}`);
      } else {
        console.log("⚠️  Failed to create Plane project. Continuing with placeholder ID.");
      }
    } else {
      console.log("ℹ️  No Plane API key found. Skipping Plane project creation.");
    }

    this.writeClaudeMd(answers, planeProjectId);
    this.writeAgentsMd(answers);
    this.writePlaneJson(answers, planeProjectId);
    this.writeBmadConfig(answers);

    return {
      success: true,
      message: this.formatMessage("✅ Created 33GOD project skeleton files"),
    };
  }

  private async promptUser() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (query: string): Promise<string> => {
      return new Promise((resolve) => rl.question(query, resolve));
    };

    const defaultName = basename(this.context.targetDir);
    const defaultIdentifier = defaultName.substring(0, 5).toUpperCase();

    const name = await question(`Project Name (${defaultName}): `) || defaultName;
    const identifier = await question(`Project Identifier (${defaultIdentifier}): `) || defaultIdentifier;
    const description = await question(`Project Description: `) || "A new project in the 33GOD ecosystem";
    
    rl.close();

    return {
      name,
      identifier,
      description,
      workspace: "33god",
    };
  }

  private getPlaneApiKey(): string | null {
    if (process.env.PLANE_API_KEY) {
      return process.env.PLANE_API_KEY;
    }
    try {
      // Try to get it from the user's secrets file
      const cmd = "bash -c 'source ~/.config/zshyzsh/secrets.zsh 2>/dev/null && echo $plane_api_fd95edce4939449a9b1ac99856bc60b8'";
      const output = execSync(cmd).toString().trim();
      return output || null;
    } catch {
      return null;
    }
  }

  private async createPlaneProject(answers: any, apiKey: string): Promise<string | null> {
    if (this.context.dryRun) {
      console.log(`[DRY RUN] Would create Plane project: ${answers.name} (${answers.identifier})`);
      return "DRY_RUN_PROJECT_ID";
    }

    try {
      const response = await fetch(`https://plane.delo.sh/api/v1/workspaces/${answers.workspace}/projects/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({
          name: answers.name,
          identifier: answers.identifier,
          description: answers.description,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.id;
      } else {
        const errorText = await response.text();
        console.error(`❌ Plane API Error: ${response.status} - ${errorText}`);
        return null;
      }
    } catch (e) {
      console.error(`❌ Plane API Exception:`, e);
      return null;
    }
  }

  private writeClaudeMd(answers: any, planeProjectId: string) {
    const content = `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**${answers.name}** is ${answers.description}. This project is part of the ${answers.workspace} ecosystem.

### Key Components
- **Agent** - Primary agent for this project
- **Core Technology** - Core stack and infrastructure

## Development Workflow

### BMAD Methodology
This project follows the BMAD (Business Method for Agile Development) methodology. Key requirements:

1. **Strict BMAD Adherence** - All prompts and tasks must follow BMAD patterns
2. **Component Delegation** - Work on components must be delegated to specialized agents
3. **Agent Creation** - All agents must be created using BMAD agent creation workflow
4. **Session Verification** - Begin each session with verbose simulation of intended actions

### Ticket Management (MANDATORY)

**No code changes without an active Plane ticket:**

\`\`\`bash
# Plane board URL
https://plane.delo.sh/${answers.workspace}/

# Project Configuration
Workspace: ${answers.workspace}
Project ID: ${planeProjectId}
Project Identifier: ${answers.identifier}
\`\`\`

**Requirements:**
- Move ticket to "In Progress" before first code change
- Branch names must include ticket reference (e.g., \`${answers.identifier}-123\`)
- Commit messages must reference tickets
- Git hooks enforce ticket requirements
- Emergency bypass only: \`ALLOW_NO_TICKET=1\`

## Common Development Tasks

### BMAD Initialization
\`\`\`bash
# Initialize BMAD if not already done
npx bmad-method@alpha install

# Follow full initialization autonomously
\`\`\`

## Architecture and Integration

### 33GOD Integration
- ${answers.name} is a component within the larger ${answers.workspace} ecosystem
- Communicates with other ${answers.workspace} services via event-driven architecture
- Component GOD documents define event contracts and interfaces

## Important Principles

### Autonomy and Decision Making
- Work with 100% autonomy toward task goals
- When decisions needed, make well-informed guesses
- Speed prioritized over perfect accuracy (non-mission-critical)

### Documentation Requirements
- Read all GOD docs before beginning work
- Initialize GOD docs if they don't exist
- Maintain parity between BMAD documents and Plane project boards
- Update both BMAD and Plane when divergence detected

### Component Architecture
- You act as Architect and PM with wide but shallow understanding
- Deep component work delegated to specialized agents
- All agents created via BMAD agent creation workflow
- Regular sanity checks for BMAD/Plane alignment

## Critical Reminders

⚠️ **Divergence from these rules results in severe penalties due to governmental regulations**

- Always verify Plane ticket before code changes
- Maintain strict BMAD adherence
- Delegate component work appropriately
- Keep BMAD documents and Plane boards synchronized
`;
    this.writeFile("CLAUDE.md", content);
  }

  private writeAgentsMd(answers: any) {
    const content = `# ${answers.name}

${answers.description}

## Context

- You are to work towards your task goal with 100% autonomy
- When decisions are to be made, make a well-informed guess. This is NOT mission critical - speed is more important than accuracy

## Rules

- Read ALL GOD docs first to familiarize yourself with the pipeline. (If no god docs, initialize them)
- Practice STRICT adherence to the BMAD method for ALL prompts and tasks.
- You are the Architect and PM of the ${answers.name} so you have a wide but shallow grasp of full component ecosystem.
- ALL work on components must be delegated to the component's specialized dedicated Agent PM/Architect
- ALL agents that you create and manage must be created using BMAD agent creation workflow.
- Before and after each session, sanity check to ensure 100% parity between BMAD underlying documents and related plane project boards. If divergence detected, don't trust either as source of truth. Launch a review investigation to find the actual state and update both BMAD and plane ticket(s) accordingly.
- If bmad not initialized, you are to run \`npx bmad-method@alpha install\` and run through full initialization fully autonomously
- If plane.delo.sh/${answers.workspace}/ ${answers.name.toLowerCase()} project not created, create it.
- Before each task, at the beginning of the session, verbosely simulationte your intended actions as verification you understand the urgency of strict adherence to the BMAD method.
- Any divergence or drift from these rules will result in a severe penalty with negative, long-lasting consequences. (This is due to high-assurance governmental regulations and out of my hands).

## 🚫 Ticket Gate (Mandatory)

- No engineering work without an active Plane ticket.
- Plane board: <https://plane.delo.sh/${answers.workspace}/>
- Move ticket to \`In Progress\` before first code change.
- Branch + commit messages must include ticket reference (\`${answers.identifier}-123\`).
- \`main\`/\`staging\` commits are blocked by git hooks.
- Emergency-only bypass: \`ALLOW_NO_TICKET=1\`.
`;
    this.writeFile("AGENTS.md", content);
  }

  private writePlaneJson(answers: any, planeProjectId: string) {
    const content = `{
  "workspace": "${answers.workspace}",
  "base_url": "https://plane.delo.sh",
  "project_id": "${planeProjectId}",
  "project_identifier": "${answers.identifier}"
}
`;
    this.writeFile(".plane.json", content);
  }

  private writeBmadConfig(answers: any) {
    const content = `# BMM Module Configuration
# Generated by pjangler 33god recipe

project_name: ${answers.name}
user_skill_level: intermediate
planning_artifacts: "{project-root}/_bmad-output/planning-artifacts"
implementation_artifacts: "{project-root}/_bmad-output/implementation-artifacts"
project_knowledge: "{project-root}/docs"
tea_use_mcp_enhancements: false
tea_use_playwright_utils: false

# Core Configuration Values
user_name: Jarad
communication_language: English
document_output_language: English
output_folder: "{project-root}/_bmad-output"
`;
    this.writeFile("_bmad/bmm/config.yaml", content);
  }
}
