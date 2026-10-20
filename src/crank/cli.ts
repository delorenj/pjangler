// `pj crank` — commander wiring for the project-native crank switches.
//
// Four subcommands (PJAN-174): enable, disable, list, log. Everything that
// knows about Redis keys, zellij tabs, or the project→tab mapping lives in
// ./index; this file only argues with commander and prints.

import type { Command } from "commander";
import { resolveProject, BoardError } from "../project/boardQuery";
import { loadProjectRegistry, projectRegistryPath } from "../project/index";
import { bold, cyan, dim, green, red, yellow, glyph } from "../utils/style";
import {
  buildCrankList,
  crankTimestamp,
  formatCrankList,
  liveTabs,
  projectAgentsFor,
  projectNameFor,
  redis,
  renderLogRow,
  resolveTabForProject,
  type ProjectNames,
} from "./index";

const xmark = `${red(glyph.fail)}`;

/** Everything needed to resolve a project onto a tab, or null off-project. */
function currentProjectNames(): { slug: string; names: ProjectNames } {
  const handle = resolveProject(process.cwd());
  let record: { name?: string; agents?: Record<string, { role?: string }> } | undefined;
  try {
    const registry = loadProjectRegistry(projectRegistryPath());
    record = registry.projects[handle.slug] as typeof record;
  } catch {
    // registry unavailable — the manifest is still a truthful answer
  }
  return {
    slug: handle.slug,
    names: {
      name: projectNameFor(handle, record?.name),
      agents: projectAgentsFor(handle, record?.agents),
    },
  };
}

/** Resolve the current project's zcrank tab against live tabs + stored keys. */
function resolveCurrentTab(): { slug: string; tab: string; storedAsIs: boolean } {
  const project = currentProjectNames();
  const store = redis();
  const storedTabs = store.tabKeys().map((key) => key.split(":").slice(2).join(":"));
  const resolution = resolveTabForProject(project.names, liveTabs(), storedTabs);
  return { slug: project.slug, tab: resolution.tab, storedAsIs: resolution.storedAsIs };
}

export function registerCrankCli(program: Command): void {
  const crankCmd = program
    .command("crank")
    .description("Toggle the zcrank crank-mode switches for the project you are standing in");

  crankCmd
    .command("enable")
    .description("Turn crank ON for this project's zellij tab (Redis zcrank:tab:<tab>)")
    .action(() => {
      runToggle(true);
    });

  crankCmd
    .command("disable")
    .description("Turn crank OFF for this project's zellij tab")
    .action(() => {
      runToggle(false);
    });

  crankCmd
    .command("list")
    .description("Every registry project with crank ON/OFF and its resolved tab, plus orphan zcrank keys")
    .action(() => {
      try {
        const store = redis();
        if (!store.ping()) {
          console.error(`${xmark} Redis is not answering at 127.0.0.1:6379 — is it running?`);
          process.exit(1);
        }
        const registry = loadProjectRegistry(projectRegistryPath());
        const projects = Object.values(registry.projects).map((record) => ({
          slug: record.slug,
          name: record.name,
          repoPath: record.repo_path,
          agents: Object.entries(record.agents ?? {}).map(([agentHandle, value]) => ({
            handle: agentHandle,
            role: String((value as { role?: string } | undefined)?.role ?? ""),
          })),
        }));
        const live = liveTabs();
        const storedTabs = store.tabKeys().map((key) => key.split(":").slice(2).join(":"));
        const report = buildCrankList({
          projects,
          live,
          storedTabs,
          tabEnabled: (tab) => store.tabEnabled(tab),
        });
        console.log(formatCrankList(report));
      } catch (error) {
        console.error(`${xmark} crank list failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  crankCmd
    .command("log")
    .description("This project's crank log (newest last)")
    .option("--tail <n>", "Show only the last N rows", "20")
    .action((options: { tail: string }) => {
      const tail = Number(options.tail);
      if (!Number.isInteger(tail) || tail <= 0) {
        console.error(`${xmark} --tail needs a positive integer, got "${options.tail}"`);
        process.exit(1);
      }
      let current: { slug: string; tab: string };
      try {
        current = resolveCurrentTab();
      } catch (error) {
        console.error(`${xmark} ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      const store = redis();
      const rows = store.logRows(current.tab);
      if (!rows.length) {
        console.log(`  ${dim(`no crank log rows for ${current.tab}`)}`);
        return;
      }
      const shown = rows.slice(-tail);
      console.log(`  ${bold("crank log")} ${dim(glyph.dot)} ${cyan(current.tab)} ${dim(`(${shown.length}/${rows.length} rows, newest last)`)}`);
      for (const raw of shown) {
        console.log(renderLogRow(raw) ?? raw);
      }
    });
}

function runToggle(enabled: boolean): void {
  try {
    const store = redis();
    if (!store.ping()) {
      console.error(`${xmark} Redis is not answering at 127.0.0.1:6379 — is it running?`);
      process.exit(1);
    }
    const project = currentProjectNames();
    const storedTabs = store.tabKeys().map((key) => key.split(":").slice(2).join(":"));
    const resolution = resolveTabForProject(project.names, liveTabs(), storedTabs);
    store.setTabEnabled(resolution.tab, enabled);
    store.pushLog(resolution.tab, enabled ? "enabled" : "disabled", `pj crank ${enabled ? "enable" : "disable"}`, crankTimestamp());
    const state = enabled ? green("ON") : dim("OFF");
    console.log(`  ${state}  ${cyan(project.slug)} ${dim(glyph.pointer)} ${bold(resolution.tab)}`);
    if (resolution.storedAsIs) {
      console.log(`  ${yellow(glyph.warn)} ${dim(`no live zellij tab or zcrank key matches "${project.names.name}" — stored under the project name as-is`)}`);
    }
  } catch (error) {
    if (error instanceof BoardError) {
      console.error(`${xmark} ${error.message}`);
    } else {
      console.error(`${xmark} crank failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
