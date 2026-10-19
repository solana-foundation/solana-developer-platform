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
  // A browser tab has session storage; the dashboard keeps its per-action
  // Idempotency-Keys there, and refuses money movements without it.
  const entries = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { pathname },
    sessionStorage: {
      getItem: (name: string) => entries.get(name) ?? null,
      setItem: (name: string, value: string) => {
        entries.set(name, value);
      },
      removeItem: (name: string) => {
        entries.delete(name);
      },
    },
  });
}

/** Undoes {@link setWindowPathname}; call from `afterEach`. */
export function restoreWindowLocation(): void {
  if (hasDom) {
    window.history.replaceState(null, "", "/");
    return;
  }
  vi.unstubAllGlobals();
}
