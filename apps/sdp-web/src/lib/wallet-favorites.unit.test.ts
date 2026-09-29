// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const scope = { userId: "user", orgId: "org" };
const offRamp = { walletId: "wa-1", name: "Off ramp demo wallet", provider: "dfns" };
const kms = { walletId: "para-1", name: "KMS", provider: "para" };

describe("walletFavoritesKey", () => {
  it("scopes pins to the person, organization and project", async () => {
    const { walletFavoritesKey } = await import("./wallet-favorites");
    expect(walletFavoritesKey(scope, "project-a")).not.toBe(walletFavoritesKey(scope, "project-b"));
    expect(walletFavoritesKey(scope, "project-a")).not.toBe(
      walletFavoritesKey({ ...scope, userId: "other" }, "project-a")
    );
    expect(walletFavoritesKey(scope, null)).toBeNull();
  });
});

describe("wallet favorites", () => {
  const key = "sdp:wallet-favorites:v1:user:org:project";

  it("appends pins in order, ignores a repeat, and survives a fresh page load", async () => {
    const firstPage = await import("./wallet-favorites");
    firstPage.addWalletFavorite(key, offRamp);
    firstPage.addWalletFavorite(key, kms);
    firstPage.addWalletFavorite(key, { ...offRamp, name: "Duplicate" });
    vi.resetModules();
    const nextPage = await import("./wallet-favorites");
    expect(nextPage.readWalletFavorites(key)).toEqual([offRamp, kms]);
  });

  it("returns the same snapshot until the stored value changes", async () => {
    const favorites = await import("./wallet-favorites");
    const first = favorites.readWalletFavorites(key);
    expect(favorites.readWalletFavorites(key)).toBe(first);
    favorites.addWalletFavorite(key, kms);
    expect(favorites.readWalletFavorites(key)).not.toBe(first);
  });

  it("removes a pin and restores an earlier list exactly", async () => {
    const favorites = await import("./wallet-favorites");
    favorites.addWalletFavorite(key, offRamp);
    favorites.addWalletFavorite(key, kms);
    const before = favorites.readWalletFavorites(key);
    favorites.removeWalletFavorite(key, "wa-1");
    expect(favorites.readWalletFavorites(key)).toEqual([kms]);
    favorites.restoreWalletFavorites(key, before);
    expect(favorites.readWalletFavorites(key)).toEqual([offRamp, kms]);
  });

  it("follows renames, drops deleted wallets, and writes nothing when nothing changed", async () => {
    const favorites = await import("./wallet-favorites");
    favorites.addWalletFavorite(key, offRamp);
    favorites.addWalletFavorite(key, kms);
    const onChange = vi.fn();
    const unsubscribe = favorites.subscribeWalletFavorites(onChange);

    favorites.syncWalletFavorites(key, [offRamp, kms]);
    expect(onChange).not.toHaveBeenCalled();

    favorites.syncWalletFavorites(key, [{ ...offRamp, name: "Off-ramp" }]);
    expect(favorites.readWalletFavorites(key)).toEqual([{ ...offRamp, name: "Off-ramp" }]);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("ignores a corrupt or malformed stored value", async () => {
    window.localStorage.setItem(key, "{not json");
    const favorites = await import("./wallet-favorites");
    expect(favorites.readWalletFavorites(key)).toBe(favorites.EMPTY_WALLET_FAVORITES);
    window.localStorage.setItem(key, JSON.stringify([{ walletId: 3 }, kms, kms]));
    expect(favorites.readWalletFavorites(key)).toEqual([kms]);
  });

  it("keeps working for the session when storage is blocked", async () => {
    const favorites = await import("./wallet-favorites");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    favorites.addWalletFavorite(key, kms);
    expect(favorites.readWalletFavorites(key)).toEqual([kms]);
  });

  it("tells the sidebar when a wallet is pinned, and when another tab changes the pins", async () => {
    const favorites = await import("./wallet-favorites");
    const onAdded = vi.fn();
    const onChange = vi.fn();
    const stopAdded = favorites.subscribeWalletFavoriteAdded(onAdded);
    const stopChange = favorites.subscribeWalletFavorites(onChange);

    favorites.addWalletFavorite(key, kms);
    expect(onAdded).toHaveBeenCalledWith("para-1");
    favorites.removeWalletFavorite(key, "para-1");
    expect(onAdded).toHaveBeenCalledTimes(1);

    window.localStorage.setItem(key, JSON.stringify([offRamp]));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(favorites.readWalletFavorites(key)).toEqual([offRamp]);
    expect(onChange).toHaveBeenCalledTimes(3);
    stopAdded();
    stopChange();
  });
});
