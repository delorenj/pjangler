// The crank dashboard's door to policy + sessions (PJAN-214). The Ink screens in ./tui.tsx never
// touch .project.json, Candybar or the engine logs themselves: they call this controller.
// No ink/react here, so the CLI and the tests can use it without loading either.

import { type DetachResult } from "./binding";
import { loadPolicy, normaliseInterval, readGlobalConfig, updateProjectBlock, DEFAULT_INTERVAL, type EffectiveCrankPolicy } from "./policy";
import { attachLiveProjectSessions, detachProject, engineLog, reclockProject, sessionViews, type LogRow, type ProjectRef, type SessionView } from "./sessions";

export interface CrankView {
  slug: string;
  root: string;
  policy: EffectiveCrankPolicy;
  /** The install default the project inherits when it sets no interval. */
  globalInterval: string;
  sessions: SessionView[];
  /** False when Candybar could not be read: `sessions` then means nothing. */
  sessionsReadable: boolean;
  sessionsError?: string;
  log: LogRow[];
}

export interface CrankController {
  slug: string;
  read(nowMs?: number): Promise<CrankView>;
  /** Flip crank.enabled; ON attaches live sessions, OFF ends them. Returns a one-line note. */
  toggle(): Promise<string>;
  /** undefined = follow the global default. */
  setInterval(interval: string | undefined): Promise<string>;
}

export interface ControllerDeps {
  project: ProjectRef;
  sessions?: (root: string, nowMs: number) => Promise<SessionView[]>;
  attach?: (project: ProjectRef) => Promise<{ attached: string[]; skipped: string[] }>;
  detach?: (root: string) => Promise<DetachResult[]>;
  log?: (names: string[], tail: number) => LogRow[];
  reclock?: (root: string) => Promise<string[]>;
  clock?: () => number;
}

export function createCrankController(deps: ControllerDeps): CrankController {
  const clock = deps.clock ?? Date.now;
  const readSessions = deps.sessions ?? ((root: string, nowMs: number) => sessionViews({ root }, undefined, nowMs));
  const attach = deps.attach ?? attachLiveProjectSessions;
  const detach = deps.detach ?? ((root: string) => detachProject(root, "disabled"));
  const readLog = deps.log ?? engineLog;
  const reclock = deps.reclock ?? ((root: string) => reclockProject(root));
  const { project } = deps;
  return {
    slug: project.slug,
    async read(nowMs = clock()) {
      const policy = loadPolicy(project.root);
      const globalInterval = normaliseInterval(readGlobalConfig(policy.globalPath).default_interval) ?? DEFAULT_INTERVAL;
      let sessions: SessionView[] = [];
      let sessionsReadable = true;
      let sessionsError: string | undefined;
      try {
        sessions = await readSessions(project.root, nowMs);
      } catch (error) {
        sessionsReadable = false;
        sessionsError = error instanceof Error ? error.message : String(error);
      }
      return { slug: project.slug, root: project.root, policy, globalInterval, sessions, sessionsReadable, sessionsError, log: readLog(sessions.map((s) => s.name), 30) };
    },
    async toggle() {
      const on = !loadPolicy(project.root).enabled;
      updateProjectBlock(project.root, (block) => ({ ...block, enabled: on }));
      if (on) {
        const { attached, skipped } = await attach(project);
        return `crank ON · ${attached.length} session(s) attached${skipped.length ? `, ${skipped.length} wait for their next start` : ""}`;
      }
      const ended = await detach(project.root);
      return `crank OFF · ${ended.length} crank(s) ended`;
    },
    async setInterval(interval) {
      updateProjectBlock(project.root, (block) => {
        if (interval) block.interval = interval;
        else delete block.interval;
        return block;
      });
      const policy = loadPolicy(project.root);
      const moved = await reclock(project.root);
      return `interval ${policy.interval}${interval ? "" : " (global default)"} · ${moved.length} live crank(s) re-clocked`;
    },
  };
}
