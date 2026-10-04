// Shared with the existing local binary reader. Per-process response lifetime
// bound only, not a global sandbox or a delivery acknowledgement.
let active = 0;
export function acquireGeneratedTransfer(): (() => void) | undefined {
  if (active >= 2) return undefined;
  active++; let released = false;
  return () => { if (!released) { released = true; active--; } };
}
