import { vi } from "vitest";

const hasDom = typeof window !== "undefined";

/**
 * Puts the tab on `pathname`, which `dashboardRequest` reads its Project from.
 * Under jsdom the real location moves via `history.replaceState`; under the node
 * environment a minimal `window` is stubbed. Undo with {@link restoreWindowLocation}.
 */
export function setWindowPathname(pathname: string): void {
  if (hasDom) {
    window.history.replaceState(null, "", pathname);
    return;
  }
  vi.stubGlobal("window", { location: { pathname } });
}

/** Undoes {@link setWindowPathname}; call from `afterEach`. */
export function restoreWindowLocation(): void {
  if (hasDom) {
    window.history.replaceState(null, "", "/");
    return;
  }
  vi.unstubAllGlobals();
}
