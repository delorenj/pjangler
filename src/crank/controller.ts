// The crank screens' door to Redis + zellij (PJAN-182). The Ink components in ./tui.tsx
// never touch either: they call a CrankController, which re-resolves the project's tab on
// every read and write, so a tab renamed under a running TUI is picked up, not clobbered.
// No ink/react here, so the CLI (and the tests) can use it without loading either.

import {
  buildCrankContext,
  disableCrank,
  enableCrank,
  keyScopeOf,
  liveTabs,
  liveTabsWithOwners,
  readEngineStatus,
  setCrankInterval,
  unknownEngineStatus,
  snapshotCrank,
  storedTabKeys,
  storedTabRoots,
  claimedRoots,
  type CrankContext,
  type CrankInterval,
  type CrankSnapshot,
  type CrankStore,
  type EnableResult,
  type EngineStatus,
  type LiveTab,
  type ProjectNames,
  type TabResolution,
} from "./index";

export interface CrankView {
  slug: string;
  name: string;
  resolution: TabResolution;
  snapshot: CrankSnapshot;
  /** Beat-engine health (PJAN-201): advisory, "unknown" when it cannot be read. */
  engine: EngineStatus;
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

/**
 * Who owns a tab changes far more slowly than its name, and finding out costs a ~4s list-panes
 * call plus git (PJAN-201 review). So the owners are kept this long, joined onto a fresh
 * (cheap) list-tabs by tab_id each time: renames are still seen at once, a new tab is looked up
 * immediately, and a toggle or interval key press no longer freezes the TUI for 4s.
 */
export const LIVE_OWNERS_TTL_MS = 300_000;

export function ownerMemoReader(
  deps: { clock?: () => number; read?: (claimed: string[]) => LiveTab[]; tabs?: () => LiveTab[]; claimed?: () => string[] } = {},
): () => LiveTab[] {
  const clock = deps.clock ?? Date.now;
  const read = deps.read ?? ((claimed: string[]) => liveTabsWithOwners({ claimed }));
  const listTabs = deps.tabs ?? (() => liveTabs());
  const readClaimed = (): string[] => {
    try {
      return deps.claimed?.() ?? [];
    } catch {
      return [];
    }
  };
  let memo: { at: number; claimed: string; byId: Map<number, Pick<LiveTab, "owner" | "ownedPanes">> } | undefined;
  return () => {
    const now = clock();
    const tabs = listTabs();
    // Claimed roots break owner ties, so a toggle that writes the first root re-reads owners at once.
    const claimed = readClaimed();
    const claimedSig = claimed.join("\n");
    if (memo && memo.claimed === claimedSig && now - memo.at <= LIVE_OWNERS_TTL_MS && tabs.length && tabs.every((tab) => tab.id !== undefined && memo?.byId.has(tab.id))) {
      const known = memo.byId;
      return tabs.map((tab) => ({ ...tab, ...known.get(tab.id as number) }));
    }
    const full = read(claimed);
    memo = full.length && full.every((tab) => tab.id !== undefined)
      ? { at: now, claimed: claimedSig, byId: new Map(full.map((tab) => [tab.id as number, { owner: tab.owner, ownedPanes: tab.ownedPanes }])) }
      : undefined;
    return full;
  };
}

export function createCrankController(deps: {
  slug: string;
  project: ProjectNames;
  store: CrankStore;
  /** Defaults to the real zellij session: live tabs with their pane-derived owners. */
  live?: () => LiveTab[];
  /** The project's identity (main worktree path), written as `root` on every key it writes. */
  identity?: string;
  /** Defaults to the Hermes usage audit; must not throw. */
  engine?: (nowMs: number) => EngineStatus;
  clock?: () => number;
}): CrankController {
  const clock = deps.clock ?? Date.now;
  const readLive = deps.live ?? ownerMemoReader({ clock, claimed: () => claimedRoots(deps.store) });
  const readEngine = (nowMs: number): EngineStatus => {
    try {
      return (deps.engine ?? ((now) => readEngineStatus({ nowMs: now })))(nowMs);
    } catch {
      return unknownEngineStatus(nowMs);
    }
  };
  let cachedLive: { at: number; tabs: LiveTab[] } | undefined;
  const live = (fresh: boolean): LiveTab[] => {
    const now = clock();
    if (fresh || !cachedLive || now - cachedLive.at > LIVE_TABS_TTL_MS) cachedLive = { at: now, tabs: readLive() };
    return cachedLive.tabs;
  };
  const context = (fresh: boolean): CrankContext => {
    const keys = storedTabKeys(deps.store);
    return buildCrankContext(deps.project, live(fresh), keys, { identity: deps.identity, roots: storedTabRoots(deps.store, keys) });
  };
  return {
    slug: deps.slug,
    name: deps.project.name,
    read(nowMs = clock()) {
      const ctx = context(false);
      return {
        slug: deps.slug,
        name: deps.project.name,
        resolution: ctx.resolution,
        snapshot: snapshotCrank(deps.store, ctx.resolution.tab, ctx.storedKeys, nowMs, 5, keyScopeOf(ctx)),
        engine: readEngine(nowMs),
      };
    },
    enable: () => enableCrank(deps.store, context(true), { now: new Date(clock()) }),
    disable() {
      const ctx = context(true);
      disableCrank(deps.store, ctx.resolution.tab, new Date(clock()), ctx.identity);
    },
    setInterval(interval) {
      const ctx = context(true);
      setCrankInterval(deps.store, ctx.resolution.tab, ctx.storedKeys, interval, new Date(clock()), { ...keyScopeOf(ctx), root: ctx.identity });
    },
  };
}
