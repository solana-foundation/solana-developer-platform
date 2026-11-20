import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WalletDetailLoading from "./[walletId]/loading";
import WalletsLoading from "./loading";
import WalletSetupLoading from "./setup/loading";

const WALLETS_DIR = dirname(fileURLToPath(import.meta.url));

/** Each route's loading boundary, by its folder under `wallets/` ("." is the overview). */
const LOADERS = {
  ".": WalletsLoading,
  setup: WalletSetupLoading,
  "[walletId]": WalletDetailLoading,
} as const satisfies Record<string, ComponentType>;

/** Every folder under `wallets/` that holds a file named `name`, relative to `wallets/`. */
function foldersHolding(name: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return walk(join(dir, entry.name));
      if (entry.name !== name) return [];
      const folder = relative(WALLETS_DIR, dir);
      return [folder === "" ? "." : folder];
    });
  return walk(WALLETS_DIR);
}

describe("wallets route loading boundaries", () => {
  // Without one, a navigation to the route holds the previous page with no sign it is loading.
  it("gives every wallets route a loading boundary", () => {
    const routes = foldersHolding("page.tsx").sort();

    expect(foldersHolding("loading.tsx").sort()).toEqual(routes);
    expect(Object.keys(LOADERS).sort()).toEqual(routes);
  });

  it.each(Object.entries(LOADERS))("marks the %s route busy while it loads", (_route, Loader) => {
    expect(renderToStaticMarkup(<Loader />)).toContain('aria-busy="true"');
  });
});
