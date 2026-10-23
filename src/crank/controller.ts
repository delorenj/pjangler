// The crank screens' door to Redis + zellij (PJAN-182). The Ink components in ./tui.tsx
// never touch either: they call a CrankController, which re-resolves the project's tab on
// every read and write, so a tab renamed under a running TUI is picked up, not clobbered.
// No ink/react here, so the CLI (and the tests) can use it without loading either.

import {
  buildCrankContext,
  disableCrank,
  enableCrank,
  liveTabs,
  setCrankInterval,
  snapshotCrank,
  storedTabKeys,
  type CrankContext,
  type CrankInterval,
  type CrankSnapshot,
  type CrankStore,
  type EnableResult,
  type LiveTab,
  type ProjectNames,
  type TabResolution,
} from "./index";

export interface CrankView {
  slug: string;
  name: string;
  resolution: TabResolution;
  snapshot: CrankSnapshot;
}

export interface CrankController {
  slug: string;
  name: string;
  read(nowMs?: number): CrankView;
  enable(): EnableResult;
  disable(): void;
  /** undefined = reset to the global default. */
  setInterval(interval: CrankInterval | undefined): void;
}

/** Zellij tab names change rarely and `list-tabs` is a subprocess: re-read them on this cadence. */
const LIVE_TABS_TTL_MS = 30_000;

export function createCrankController(deps: {
  slug: string;
  project: ProjectNames;
  store: CrankStore;
  /** Defaults to the real zellij session. */
  live?: () => LiveTab[];
  clock?: () => number;
}): CrankController {
  const clock = deps.clock ?? Date.now;
  const readLive = deps.live ?? (() => liveTabs());
  let cachedLive: { at: number; tabs: LiveTab[] } | undefined;
  const live = (fresh: boolean): LiveTab[] => {
    const now = clock();
    if (fresh || !cachedLive || now - cachedLive.at > LIVE_TABS_TTL_MS) cachedLive = { at: now, tabs: readLive() };
    return cachedLive.tabs;
  };
  const context = (fresh: boolean): CrankContext => buildCrankContext(deps.project, live(fresh), storedTabKeys(deps.store));
  return {
    slug: deps.slug,
    name: deps.project.name,
    read(nowMs = clock()) {
      const ctx = context(false);
      return { slug: deps.slug, name: deps.project.name, resolution: ctx.resolution, snapshot: snapshotCrank(deps.store, ctx.resolution.tab, ctx.storedKeys, nowMs) };
    },
    enable: () => enableCrank(deps.store, context(true), { now: new Date(clock()) }),
    disable() {
      disableCrank(deps.store, context(true).resolution.tab, new Date(clock()));
    },
    setInterval(interval) {
      const ctx = context(true);
      setCrankInterval(deps.store, ctx.resolution.tab, ctx.storedKeys, interval, new Date(clock()));
    },
  };
}
