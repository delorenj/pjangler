// `pj crank` — the control surface for crank v2 (PJAN-214): one crank per live interactive agent
// session, clocked by its own Candybar, enabled by the project's `.project.json` `crank` block
// (or the install default in $XDG_CONFIG_HOME/33god/crank.toml).
//
//   policy    enable | disable | interval | config | status       (./policy)
//   sessions  sessions | attach | detach | reap | log              (./binding, ./sessions)
//   engine    fire <binding>   (the Candybar exec entry point; runs the crank-pane engine)
//   views     tui | panes
//
// The tab-keyed Redis switches (zcrank:tab:*) of PJAN-174/182 are retired: `enable` turns the
// project's legacy tab switch off so the old beat never double-drives a session. Their readers
// (./index) stay for the prompt segment and the legacy beat until those move over too.

import type { Command } from "commander";
import { resolveProject, BoardError } from "../project/boardQuery";
import { loadProjectRegistry, projectRegistryPath } from "../project/index";
import { bold, cyan, dim, green, red, yellow, glyph } from "../utils/style";
import { isInteractive, loadScreen, TuiUnavailableError } from "../tui/load";
import { formatPaneTable, inventoryPanes } from "./panes";
import {
  buildCrankContext,
  disableCrank,
  liveTabsWithOwners,
  projectAgentsFor,
  projectIdentity,
  projectNameFor,
  redis,
  storedTabKeys,
  storedTabRoots,
  type CrankContext,
  type CrankStore,
  type ProjectNames,
} from "./index";
import {
  CRANK_INTERVAL_CHOICES,
  CrankPolicyError,
  GLOBAL_KEYS,
  PROJECT_KEYS,
  coerceValue,
  globalConfigPath,
  loadPolicy,
  normaliseInterval,
  readGlobalConfig,
  readProjectBlock,
  updateProjectBlock,
  writeGlobalConfig,
  type EffectiveCrankPolicy,
} from "./policy";
import { reapBindings, type DetachResult, type EndReason } from "./binding";
import {
  attachLiveProjectSessions,
  attachSession,
  callerSession,
  detachProject,
  detachSession,
  engineLog,
  fireBinding,
  hookLog,
  hookSession,
  projectAt,
  reclockProject,
  sessionViews,
  type ProjectRef,
  type SessionView,
} from "./sessions";

type CrankScreens = typeof import("./tui");
const loadCrankScreens = () => loadScreen<CrankScreens>("./crank/tui.js", import.meta.url);

const xmark = `${red(glyph.fail)}`;

// ---------------------------------------------------------------------------
// Legacy tab resolution (kept: dist/prompt-refresh.js imports these two)
// ---------------------------------------------------------------------------

/** Everything needed to resolve a project onto a tab, or null off-project. Shared with dist/prompt-refresh.js. */
export function currentProjectNames(): { slug: string; names: ProjectNames; identity?: string } {
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
    // PJAN-201: where the project lives (its main worktree), independent of any tab name.
    identity: projectIdentity(handle.root),
  };
}

/** Resolve a project onto a tab against live tabs (with pane owners) and stored keys + roots. */
export function contextFor(project: { names: ProjectNames; identity?: string }, store: CrankStore): CrankContext {
  const keys = storedTabKeys(store);
  const roots = storedTabRoots(store, keys);
  return buildCrankContext(project.names, liveTabsWithOwners({ claimed: Object.values(roots) }), keys, { identity: project.identity, roots });
}

/** Turn this project's legacy zcrank:tab switch OFF so the old beat stops driving its tab. Best effort. */
function retireLegacyTab(): string | undefined {
  try {
    const store = redis();
    if (!store.ping()) return undefined;
    const ctx = contextFor(currentProjectNames(), store);
    if (store.tabEnabled(ctx.resolution.tab) !== "1") return undefined;
    disableCrank(store, ctx.resolution.tab, new Date(), ctx.identity);
    return ctx.resolution.tab;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fail(error: unknown, what: string): never {
  if (error instanceof BoardError || error instanceof TuiUnavailableError || error instanceof CrankPolicyError) {
    console.error(`${xmark} ${error.message}`);
  } else {
    console.error(`${xmark} ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

function sourceNote(source: string): string {
  return source === "project" ? ".project.json" : source === "global" ? "global crank.toml" : "built-in default";
}

export function formatAgo(ms: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatIn(ms: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((ms - nowMs) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

function printPolicy(slug: string, policy: EffectiveCrankPolicy): void {
  console.log(`  ${bold("crank")} ${dim(glyph.dot)} ${cyan(slug)}  ${policy.enabled ? green("ON") : dim("OFF")} ${dim(`(${sourceNote(policy.enabledSource)})`)}`);
  console.log(`  ${dim("interval ")} ${policy.interval} ${dim(`(${sourceNote(policy.intervalSource)})`)}`);
  if (policy.prompt) console.log(`  ${dim("prompt   ")} ${policy.prompt} ${dim(`(${sourceNote(policy.promptSource ?? "default")})`)}`);
  if (policy.target) console.log(`  ${dim("target   ")} ${policy.target}`);
  for (const rule of policy.rules) console.log(`  ${dim("rule     ")} ${rule}`);
  console.log(`  ${dim(`officer   ${policy.officerProfile}, ≤${policy.officerMaxTurns} turns · zellij session ${policy.zellijSession} · globals ${policy.globalPath}`)}`);
}

export function formatSessions(views: SessionView[], nowMs = Date.now()): string {
  if (!views.length) return `  ${dim("no live crank sessions")}`;
  const lines: string[] = [];
  for (const view of views) {
    const last = view.lastRuns[0];
    const lastText = last ? `${last.result} ${formatAgo(Date.parse(last.startedAt), nowMs)}` : "never fired";
    const next = view.nextFireMs ? formatIn(view.nextFireMs, nowMs) : "?";
    const state = view.alive ? green(glyph.dot) : red(glyph.fail);
    lines.push(`  ${state} ${bold(view.name)}  ${cyan(view.projectSlug)} ${dim(`${view.cli} ${view.sessionId.slice(0, 8)} · pane terminal_${view.paneId} · every ${view.interval || "?"} · last ${lastText} · next ${next}${view.lastClass ? ` · ${view.lastClass}` : ""}`)}`);
    if (!view.alive) lines.push(`    ${yellow(glyph.warn)} ${dim("agent process is gone; the next fire or `pj crank reap` ends this crank")}`);
  }
  return lines.join("\n");
}

function printDetached(results: DetachResult[]): void {
  for (const result of results) {
    if (result.archived) console.log(`  ${dim("ended")} ${bold(result.name)} ${dim(`(${result.reason})`)}`);
    else console.log(`  ${yellow(glyph.warn)} ${result.name}: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerCrankCli(program: Command): void {
  const crankCmd = program
    .command("crank")
    .description("Crank: one Candybar-clocked officer per live interactive agent session, driven by the project's crank block");

  crankCmd
    .command("status")
    .description("This project's crank policy (with where each value comes from) and its live crank sessions")
    .option("--json", "Emit JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const project = projectAt(process.cwd());
        const policy = loadPolicy(project.root);
        // An unreachable Candybar is "sessions unknown", never "no sessions".
        let views: SessionView[] = [];
        let sessionsError: string | undefined;
        try {
          views = await sessionViews({ root: project.root });
        } catch (error) {
          sessionsError = error instanceof Error ? error.message : String(error);
        }
        if (options.json) {
          console.log(JSON.stringify({ project, policy, sessions: sessionsError ? null : views, ...(sessionsError ? { sessionsError } : {}) }, null, 2));
          return;
        }
        printPolicy(project.slug, policy);
        console.log("");
        console.log(sessionsError ? `  ${yellow(glyph.warn)} sessions unknown: Candybar unreadable (${sessionsError})` : formatSessions(views));
      } catch (error) {
        fail(error, "crank status");
      }
    });

  crankCmd
    .command("enable")
    .description("Turn crank ON for this project (writes .project.json crank.enabled) and attach its live agent sessions; --global sets the install default")
    .option("--interval <interval>", `How often each session is cranked: ${CRANK_INTERVAL_CHOICES.join("|")} or any <N>m/<N>h/1d (asked in a terminal when omitted)`)
    .option("--global", "Set enabled_by_default in the global crank.toml instead")
    .option("--no-attach", "Only write the policy; sessions attach at their next start")
    .action(async (options: { interval?: string; global?: boolean; attach?: boolean }) => {
      await runEnable(options);
    });

  crankCmd
    .command("disable")
    .description("Turn crank OFF for this project and end its live cranks; --global clears the install default")
    .option("--global", "Set enabled_by_default = false in the global crank.toml instead")
    .action(async (options: { global?: boolean }) => {
      await runDisable(options);
    });

  crankCmd
    .command("interval <interval>")
    .description("Set this project's crank interval (<N>m, <N>h, 1d), or 'default' to follow the global default; --global sets that default")
    .option("--global", "Set default_interval in the global crank.toml")
    .action(async (value: string, options: { global?: boolean }) => {
      try {
        if (options.global) {
          if (value === "default") throw new CrankPolicyError("the global default cannot inherit; give an interval");
          const config = readGlobalConfig();
          config.default_interval = coerceValue("default_interval", value) as string;
          writeGlobalConfig(config);
          console.log(`  ${dim("global default interval")} ${bold(config.default_interval)} ${dim(globalConfigPath())}`);
          return;
        }
        const project = projectAt(process.cwd());
        const interval = value === "default" ? undefined : (coerceValue("interval", value) as string);
        updateProjectBlock(project.root, (block) => {
          if (interval) block.interval = interval;
          else delete block.interval;
          return block;
        });
        const policy = loadPolicy(project.root);
        console.log(`  ${cyan(project.slug)} ${dim("interval")} ${bold(policy.interval)} ${dim(`(${sourceNote(policy.intervalSource)})`)}`);
        const moved = await reclockProject(project.root).catch(() => [] as string[]);
        for (const name of moved) console.log(`  ${dim(`re-clocked ${name}`)}`);
      } catch (error) {
        fail(error, "crank interval");
      }
    });

  crankCmd
    .command("config [action] [key] [value]")
    .description(`Read or edit the crank block: config | config get <key> | config set <key> <value> | config unset <key>. Project keys: ${PROJECT_KEYS.join(", ")}; --global keys: ${GLOBAL_KEYS.join(", ")}`)
    .option("--global", "Edit the install-wide crank.toml instead of .project.json")
    .option("--json", "Emit JSON")
    .action((action: string | undefined, key: string | undefined, value: string | undefined, options: { global?: boolean; json?: boolean }) => {
      runConfig(action, key, value, options);
    });

  crankCmd
    .command("sessions")
    .alias("list")
    .description("Live crank sessions (one per agent session): this project's, or --all")
    .option("--all", "Every project")
    .option("--json", "Emit JSON")
    .action(async (options: { all?: boolean; json?: boolean }) => {
      try {
        const root = options.all ? undefined : projectAt(process.cwd()).root;
        const views = await sessionViews({ root });
        if (options.json) console.log(JSON.stringify(views, null, 2));
        else console.log(formatSessions(views));
      } catch (error) {
        fail(error, "crank sessions");
      }
    });

  crankCmd
    .command("attach")
    .description("Bind a crank to an agent session. --hook reads a SessionStart payload (hook-hub); otherwise the session pj runs inside")
    .option("--hook", "Hook mode: payload on stdin, BB_HOOK_* env; never fails the hook")
    .option("--cli <cli>", "Agent CLI (claude, codex, opencode, kimi, …)")
    .option("--session-id <id>", "Native session id")
    .option("--pid <pid>", "Agent process id")
    .option("--force", "Attach even when the project's crank is off")
    .action(async (options: { hook?: boolean; cli?: string; sessionId?: string; pid?: string; force?: boolean }) => {
      await runAttach(options);
    });

  crankCmd
    .command("detach [binding]")
    .description("End a crank: by binding name, --session-id, or (--hook) the SessionEnd payload's session")
    .option("--hook", "Hook mode: SessionEnd payload on stdin, BB_HOOK_* env; never fails the hook")
    .option("--session-id <id>", "End every crank of this native session")
    .option("--reason <reason>", "explicit|session_end|superseded|disabled|pane_closed|orphan_reaped", "explicit")
    .action(async (binding: string | undefined, options: { hook?: boolean; sessionId?: string; reason: string }) => {
      await runDetach(binding, options);
    });

  crankCmd
    .command("reap")
    .description("End every crank whose agent process is gone, announcing each as bloodbank.crank.binding.ended reason=orphan_reaped")
    .option("--json", "Emit JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const results = await reapBindings();
        if (options.json) console.log(JSON.stringify(results, null, 2));
        else if (!results.length) console.log(`  ${dim("no dangling cranks")}`);
        else printDetached(results);
      } catch (error) {
        fail(error, "crank reap");
      }
    });

  crankCmd
    .command("fire <binding>")
    .description("One crank fire (Candybar runs this): verify the session is alive, then run the crank-pane engine")
    .action(async (binding: string) => {
      try {
        const outcome = await fireBinding(binding);
        console.log(JSON.stringify(outcome));
        if (outcome.outcome === "fired" && outcome.engineExit && outcome.engineExit !== 0) process.exit(outcome.engineExit);
      } catch (error) {
        fail(error, "crank fire");
      }
    });

  crankCmd
    .command("log")
    .description("This project's crank engine log: what each fire saw and did (newest last)")
    .option("--tail <n>", "Show only the last N rows", "20")
    .option("--all", "Every project")
    .action(async (options: { tail: string; all?: boolean }) => {
      const tail = Number(options.tail);
      if (!Number.isInteger(tail) || tail <= 0) {
        console.error(`${xmark} --tail needs a positive integer, got "${options.tail}"`);
        process.exit(1);
      }
      try {
        const root = options.all ? undefined : projectAt(process.cwd()).root;
        const views = await sessionViews({ root });
        const rows = engineLog(views.map((view) => view.name), tail);
        if (!rows.length) {
          console.log(`  ${dim("no crank fires logged yet")}`);
          return;
        }
        for (const row of rows) {
          console.log(`  ${dim(row.ts)} ${cyan(row.binding)} ${row.state.padEnd(9)} ${row.action}${row.detail ? dim(` · ${row.detail.split("\n").pop()}`) : ""}`);
        }
      } catch (error) {
        fail(error, "crank log");
      }
    });

  crankCmd
    .command("tui")
    .description("Full-screen crank dashboard: project toggle, interval, live sessions with last/next fire, log")
    .action(async () => {
      await runTui();
    });

  crankCmd
    .command("panes")
    .description("Read-only inventory of the live agent panes in this zellij session: pane -> pid -> agent CLI -> session id/status (from /proc, not tab names)")
    .option("--json", "Emit the inventory as JSON")
    .option("--all", "Also list terminal panes that run no agent")
    .action((options: { json?: boolean; all?: boolean }) => {
      runPanes(options);
    });
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

async function pickInterval(project: ProjectRef, policy: EffectiveCrankPolicy): Promise<string | null | undefined> {
  if (!isInteractive()) return undefined;
  const screens = await loadCrankScreens();
  return screens.pickInterval({
    slug: project.slug,
    effective: policy.interval,
    inherited: policy.intervalSource !== "project",
    global: normaliseInterval(readGlobalConfig().default_interval) ?? policy.interval,
  });
}

async function runEnable(options: { interval?: string; global?: boolean; attach?: boolean }): Promise<void> {
  try {
    if (options.global) {
      const config = readGlobalConfig();
      config.enabled_by_default = true;
      if (options.interval) config.default_interval = coerceValue("default_interval", options.interval) as string;
      writeGlobalConfig(config);
      console.log(`  ${green("ON")}  ${dim("by default for every project without its own crank.enabled")} ${dim(globalConfigPath())}`);
      return;
    }
    const project = projectAt(process.cwd());
    let interval = options.interval ? (coerceValue("interval", options.interval) as string) : undefined;
    if (!interval) {
      const before = loadPolicy(project.root);
      const picked = await pickInterval(project, before);
      if (picked === null) {
        console.log(`  ${yellow(glyph.warn)} aborted ${dim(glyph.dot)} crank left as it was for ${cyan(project.slug)}`);
        return;
      }
      // Confirming the inherited value keeps inheriting; only a real choice becomes an override.
      if (picked && !(before.intervalSource !== "project" && picked === before.interval)) interval = picked;
    }
    updateProjectBlock(project.root, (block) => ({ ...block, enabled: true, ...(interval ? { interval } : {}) }));
    const policy = loadPolicy(project.root);
    console.log(`  ${green("ON")}  ${cyan(project.slug)} ${dim(`every ${policy.interval} (${sourceNote(policy.intervalSource)})`)}`);
    const legacy = retireLegacyTab();
    if (legacy) console.log(`  ${dim(`legacy tab switch zcrank:tab:${legacy} turned off (sessions are cranked one by one now)`)}`);
    if (options.attach === false) return;
    const { attached, skipped } = await attachLiveProjectSessions(project);
    const caller = callerSession();
    if (caller && !attached.length) {
      const own = await attachSession(caller);
      if (own.status === "attached" || own.status === "already") attached.push(own.name ?? "");
    }
    for (const name of attached) console.log(`  ${dim("crank")} ${bold(name)}`);
    for (const note of skipped) console.log(`  ${dim(`not attached: ${note}`)}`);
    if (!attached.length && !skipped.length) console.log(`  ${dim("no live agent sessions in this project yet; each one gets a crank when it starts")}`);
  } catch (error) {
    fail(error, "crank enable");
  }
}

async function runDisable(options: { global?: boolean }): Promise<void> {
  try {
    if (options.global) {
      const config = readGlobalConfig();
      config.enabled_by_default = false;
      writeGlobalConfig(config);
      console.log(`  ${dim("OFF")} ${dim("by default (projects with crank.enabled = true keep it)")} ${dim(globalConfigPath())}`);
      return;
    }
    const project = projectAt(process.cwd());
    updateProjectBlock(project.root, (block) => ({ ...block, enabled: false }));
    console.log(`  ${dim("OFF")}  ${cyan(project.slug)}`);
    retireLegacyTab();
    // Policy first: if Candybar cannot be reached now, every live crank still ends itself on
    // its next fire (pj crank fire sees the policy OFF and detaches with reason "disabled").
    printDetached(await detachProject(project.root, "disabled"));
  } catch (error) {
    fail(error, "crank disable");
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function runConfig(action: string | undefined, key: string | undefined, value: string | undefined, options: { global?: boolean; json?: boolean }): void {
  try {
    const verb = action ?? "show";
    const keys: readonly string[] = options.global ? GLOBAL_KEYS : PROJECT_KEYS;
    if (key !== undefined && !keys.includes(key)) throw new CrankPolicyError(`unknown ${options.global ? "global" : "project"} key "${key}" (one of ${keys.join(", ")})`);
    if (options.global) {
      const config = readGlobalConfig();
      if (verb === "show" || verb === "get") {
        const out = key ? config[key] : config;
        console.log(options.json || typeof out === "object" ? JSON.stringify(out ?? null, null, 2) : String(out ?? ""));
        if (!key && !options.json) console.error(dim(`  ${globalConfigPath()}`));
        return;
      }
      if (!key) throw new CrankPolicyError(`config ${verb} needs a key`);
      if (verb === "set") {
        if (value === undefined) throw new CrankPolicyError("config set needs a value");
        config[key] = coerceValue(key, value);
      } else if (verb === "unset") delete config[key];
      else throw new CrankPolicyError(`unknown config action "${verb}" (get|set|unset)`);
      writeGlobalConfig(config);
      console.log(`  ${dim("global")} ${key} = ${JSON.stringify(config[key] ?? null)}`);
      return;
    }
    const project = projectAt(process.cwd());
    if (verb === "show" || verb === "get") {
      if (key) {
        const out = readProjectBlock(project.root)?.[key];
        console.log(options.json || typeof out === "object" ? JSON.stringify(out ?? null, null, 2) : String(out ?? ""));
        return;
      }
      const policy = loadPolicy(project.root);
      if (options.json) console.log(JSON.stringify({ block: readProjectBlock(project.root) ?? null, effective: policy }, null, 2));
      else printPolicy(project.slug, policy);
      return;
    }
    if (!key) throw new CrankPolicyError(`config ${verb} needs a key`);
    const next = updateProjectBlock(project.root, (block) => {
      if (verb === "set") {
        if (value === undefined) throw new CrankPolicyError("config set needs a value");
        block[key] = coerceValue(key, value);
      } else if (verb === "unset") delete block[key];
      else throw new CrankPolicyError(`unknown config action "${verb}" (get|set|unset)`);
      return block;
    });
    console.log(`  ${cyan(project.slug)} crank.${key} = ${JSON.stringify(next?.[key] ?? null)}`);
  } catch (error) {
    fail(error, "crank config");
  }
}

// ---------------------------------------------------------------------------
// attach / detach (hook entry points never exit non-zero)
// ---------------------------------------------------------------------------

async function runAttach(options: { hook?: boolean; cli?: string; sessionId?: string; pid?: string; force?: boolean }): Promise<void> {
  if (options.hook) {
    const input = hookSession();
    try {
      const result = await attachSession(input);
      hookLog({ hook: "attach", cli: input.cli, session: input.sessionId, pid: input.pid, cwd: input.cwd, source: input.source, status: result.status, name: "name" in result ? result.name : undefined, reason: "reason" in result ? result.reason : undefined, superseded: result.superseded, reaped: result.reaped });
    } catch (error) {
      hookLog({ hook: "attach", cli: input.cli, session: input.sessionId, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  try {
    const caller = callerSession();
    const input = options.sessionId || options.cli
      ? { cli: options.cli ?? caller?.cli, sessionId: options.sessionId ?? caller?.sessionId, pid: options.pid ? Number(options.pid) : caller?.pid, cwd: process.cwd() }
      : caller;
    if (!input) throw new CrankPolicyError("not running inside an agent session: pass --cli and --session-id (and --pid for CLIs without a session file)");
    const result = await attachSession(input, { force: options.force });
    if (result.status === "attached" || result.status === "already") {
      console.log(`  ${green(glyph.dot)} ${bold(result.name ?? "")} ${dim(`${result.status} · ${result.schedule ?? ""}`)}`);
    } else {
      console.error(`${xmark} not attached: ${"reason" in result ? result.reason : result.status}`);
      process.exit(1);
    }
    for (const name of result.superseded) console.log(`  ${dim(`ended ${name} (superseded)`)}`);
    for (const name of result.reaped) console.log(`  ${dim(`ended ${name} (orphan_reaped)`)}`);
  } catch (error) {
    fail(error, "crank attach");
  }
}

async function runDetach(binding: string | undefined, options: { hook?: boolean; sessionId?: string; reason: string }): Promise<void> {
  if (options.hook) {
    const input = hookSession();
    try {
      const results = input.sessionId ? await detachSession({ cli: input.cli, sessionId: input.sessionId }, "session_end") : [];
      hookLog({ hook: "detach", cli: input.cli, session: input.sessionId, reason: input.reason, ended: results.map((r) => r.name) });
    } catch (error) {
      hookLog({ hook: "detach", cli: input.cli, session: input.sessionId, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  try {
    const reason = options.reason as EndReason;
    if (!["explicit", "session_end", "superseded", "disabled", "pane_closed", "orphan_reaped"].includes(reason)) throw new CrankPolicyError(`unknown reason "${options.reason}"`);
    let results: DetachResult[] = [];
    if (binding) {
      const { listBindings, detachBinding } = await import("./binding");
      const record = (await listBindings()).find((candidate) => candidate.name === binding);
      if (!record) throw new CrankPolicyError(`no live crank named ${binding}`);
      results = [await detachBinding(record, reason)];
    } else {
      const sessionId = options.sessionId ?? callerSession()?.sessionId;
      if (!sessionId) throw new CrankPolicyError("name a binding, or --session-id");
      results = await detachSession({ sessionId }, reason);
    }
    if (!results.length) console.log(`  ${dim("no live crank matched")}`);
    printDetached(results);
  } catch (error) {
    fail(error, "crank detach");
  }
}

// ---------------------------------------------------------------------------
// panes / tui
// ---------------------------------------------------------------------------

/**
 * PJAN-202: print the pane inventory. Touches no Redis and no zellij action but list-panes.
 *
 * `--json` is an ENVELOPE, not a bare array: `zellijReadable: false` means "unknown" (panes is
 * then empty and means nothing), `zellijReadable: true` with `panes: []` means "none". The exit
 * code says the same: 1 when zellij is unreadable or the session does not exist, in both modes.
 */
function runPanes(options: { json?: boolean; all?: boolean }): void {
  try {
    const inventory = inventoryPanes({ all: options.all === true });
    const sessionNote =
      inventory.sessionSource === "default"
        ? `not inside zellij ($ZELLIJ_SESSION_NAME is unset): using the default session "${inventory.session}"`
        : inventory.sessionSource === "ZELLIJ_SESSION_NAME"
          ? `session "${inventory.session}" (from $ZELLIJ_SESSION_NAME)`
          : `session "${inventory.session}"`;
    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
    }
    if (!inventory.zellijReadable) {
      console.error(`${xmark} ${inventory.error ?? "zellij is unreadable"} — ${sessionNote}`);
      process.exit(1);
    }
    if (options.json) {
      if (inventory.unmappedPaneIds.length) console.error(`  ${dim(`${inventory.unmappedPaneIds.length} pane id(s) with agent processes are not listed by zellij: ${inventory.unmappedPaneIds.join(", ")}`)}`);
      return;
    }
    if (inventory.sessionSource === "default") console.error(`  ${yellow(glyph.warn)} ${dim(sessionNote)}`);
    if (inventory.unmappedPaneIds.length) {
      console.error(`  ${dim(`ignored ${inventory.unmappedPaneIds.length} pane id(s) with agent processes that zellij does not list (a closed pane, a pane that closed during the scan, or a stale daemon environment): ${inventory.unmappedPaneIds.join(", ")}`)}`);
    }
    if (!inventory.panes.length) {
      console.log(`  ${dim(`no live agent panes in session ${inventory.session}`)}`);
      return;
    }
    console.log(formatPaneTable(inventory));
  } catch (error) {
    fail(error, "crank panes");
  }
}

async function runTui(): Promise<void> {
  try {
    if (!isInteractive()) {
      console.error(`${xmark} pj crank tui needs an interactive terminal (stdin and stdout must be a TTY)`);
      process.exit(1);
    }
    const project = projectAt(process.cwd());
    const { createCrankController } = await import("./controller");
    const controller = createCrankController({ project });
    const screens = await loadCrankScreens();
    await screens.runCrankDashboard(controller);
  } catch (error) {
    fail(error, "crank tui");
  }
}
