// Small hooks Ink screens share.

import { useEffect, useState } from "react";

/** `Date.now()`, re-read every `ms` (default 1s): a live clock for countdowns. */
export function useNow(ms = 1000, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), ms);
    return () => clearInterval(timer);
  }, [ms, clock]);
  return now;
}

/** Run `tick` every `ms` for the life of the component. */
export function useInterval(tick: () => void, ms: number): void {
  useEffect(() => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }, [tick, ms]);
}
