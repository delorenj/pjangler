// `pj crank` — commander wiring for the project-native crank switches.
//
// Five subcommands: enable, disable, list, log (PJAN-174) and tui (PJAN-182). Everything
// that knows about Redis keys, zellij tabs, or the project→tab mapping lives in ./index;
// this file only argues with commander and prints. The Ink screens (./tui.tsx) are loaded
// on demand, so every other pj command stays free of ink/react.

import type { Command } from "commander";
import { resolveProject, BoardError } from "../project/boardQuery";
import { loadProjectRegistry, projectRegistryPath } from "../project/index";
import { bold, cyan, dim, green, red, yellow, glyph } from "../utils/style";
import { isInteractive, loadScreen, TuiUnavailableError } from "../tui/load";
import { createCrankController } from "./controller";
import {
  ZCRANK_INTERVALS,
  buildCrankContext,
  buildCrankList,
  disableCrank,
  enableCrank,
  formatCrankList,
  liveTabs,
  parseInterval,
  projectAgentsFor,
  projectNameFor,
  redis,
  renderLogRow,
  snapshotCrank,
  storedTabKeys,
  type CrankInterval,
  type ProjectNames,
} from "./index";

type CrankScreens = typeof import("./tui");
const loadCrankScreens = () => loadScreen<CrankScreens>("./crank/tui.js", import.meta.url);

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
  const ctx = buildCrankContext(project.names, liveTabs(), storedTabKeys(store));
  return { slug: project.slug, tab: ctx.resolution.tab, storedAsIs: ctx.resolution.storedAsIs };
}

export function registerCrankCli(program: Command): void {
  const crankCmd = program
    .command("crank")
    .description("Toggle the zcrank crank-mode switches for the project you are standing in");

  crankCmd
    .command("enable")
    .description("Turn crank ON for this project's zellij tab (Redis zcrank:tab:<tab>); a renamed tab's old key is merged away")
    .option("--interval <interval>", `How often the crank may touch the tab: ${ZCRANK_INTERVALS.join("|")} (asked in a terminal when omitted)`)
    .action(async (options: { interval?: string }) => {
      await runEnable(options);
    });

  crankCmd
    .command("disable")
    .description("Turn crank OFF for this project's zellij tab")
    .action(() => {
      runDisable();
    });

  crankCmd
    .command("tui")
    .description("Full-screen crank dashboard: toggle, interval, last runs, countdown to the next run, log")
    .action(async () => {
      await runTui();
    });

  crankCmd
    .command("list")
    .description("Every registry project with crank ON/OFF and its resolved tab, plus orphan zcrank keys")
    .action(() => {
      try {
        const store = redis();
        if (!store.ping()) {
          console.error(`${xmark} Redis is not answering at ${store.endpoint} — is it running?`);
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
        const storedTabs = storedTabKeys(store);
        const report = buildCrankList({
          projects,
          live,
          storedTabs,
          tabEnabled: (tab) => store.tabEnabled(tab),
          tabInterval: (tab) => store.tabInterval(tab),
          globalInterval: store.globalInterval(),
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

function fail(error: unknown, what: string): never {
  if (error instanceof BoardError || error instanceof TuiUnavailableError) {
    console.error(`${xmark} ${error.message}`);
  } else {
    console.error(`${xmark} ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

/** A reachable store, or exit 1 in the same words `pj crank list` uses. */
function liveStore() {
  const store = redis();
  if (!store.ping()) {
    console.error(`${xmark} Redis is not answering at ${store.endpoint} — is it running?`);
    process.exit(1);
  }
  return store;
}

async function runEnable(options: { interval?: string }): Promise<void> {
  try {
    let chosen: CrankInterval | undefined;
    if (options.interval !== undefined) {
      chosen = parseInterval(options.interval);
      if (!chosen) {
        console.error(`${xmark} --interval needs one of ${ZCRANK_INTERVALS.join(", ")}, got "${options.interval}"`);
        process.exit(1);
      }
    }
    const store = liveStore();
    const project = currentProjectNames();
    const ctx = buildCrankContext(project.names, liveTabs(), storedTabKeys(store));
    if (!chosen && isInteractive()) {
      // Ask. The picker opens on what the tab runs at now; confirming that while it is only
      // inherited changes nothing, so the tab keeps following the global default.
      const snap = snapshotCrank(store, ctx.resolution.tab, ctx.storedKeys, Date.now());
      const screens = await loadCrankScreens();
      const picked = await screens.pickInterval({ slug: project.slug, tab: ctx.resolution.liveTab ?? ctx.resolution.tab, effective: snap.interval, inherited: snap.inherited, global: snap.global });
      if (!picked) {
        console.log(`  ${yellow(glyph.warn)} aborted ${dim(glyph.dot)} crank left as it was for ${cyan(project.slug)}`);
        return;
      }
      if (!(snap.inherited && picked === snap.interval)) chosen = picked;
    }
    const result = enableCrank(store, ctx, { interval: chosen });
    console.log(`  ${green("ON")}  ${cyan(project.slug)} ${dim(glyph.pointer)} ${bold(result.tab)}`);
    for (const { from, to } of result.renamed) {
      console.log(`  ${yellow(glyph.warn)} tab renamed ${dim(glyph.dot)} ${from} ${dim(glyph.pointer)} ${bold(to)} ${dim("(old key merged into the new one and removed)")}`);
    }
    const live = snapshotCrank(store, result.tab, storedTabKeys(store), Date.now());
    console.log(`  ${dim("interval")} ${live.interval}${live.inherited ? dim(` (inherits global ${live.global})`) : ""}`);
    if (ctx.resolution.storedAsIs) {
      console.log(`  ${yellow(glyph.warn)} ${dim(`no live zellij tab or zcrank key matches "${project.names.name}" — stored under the project name as-is`)}`);
    }
  } catch (error) {
    fail(error, "crank");
  }
}

function runDisable(): void {
  try {
    const store = liveStore();
    const project = currentProjectNames();
    const ctx = buildCrankContext(project.names, liveTabs(), storedTabKeys(store));
    disableCrank(store, ctx.resolution.tab);
    console.log(`  ${dim("OFF")}  ${cyan(project.slug)} ${dim(glyph.pointer)} ${bold(ctx.resolution.tab)}`);
    if (ctx.resolution.storedAsIs) {
      console.log(`  ${yellow(glyph.warn)} ${dim(`no live zellij tab or zcrank key matches "${project.names.name}" — stored under the project name as-is`)}`);
    }
  } catch (error) {
    fail(error, "crank");
  }
}

async function runTui(): Promise<void> {
  try {
    if (!isInteractive()) {
      console.error(`${xmark} pj crank tui needs an interactive terminal (stdin and stdout must be a TTY)`);
      process.exit(1);
    }
    const store = liveStore();
    const project = currentProjectNames();
    const controller = createCrankController({ slug: project.slug, project: project.names, store });
    const screens = await loadCrankScreens();
    await screens.runCrankDashboard(controller);
  } catch (error) {
    fail(error, "crank tui");
  }
}
