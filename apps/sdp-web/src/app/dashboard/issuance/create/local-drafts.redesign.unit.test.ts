// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftState } from "./draft-model";

vi.mock("@/contexts/dashboard-workspace-context", () => ({ useDashboardWorkspace: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

const scope = { userId: "user", orgId: "org" };

const fresh: DraftState = {
  assetClass: "stablecoin",
  name: "",
  symbol: "",
  description: "",
  website: "",
  maxSupply: "",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  issuerName: "",
  freezeAccounts: true,
  permanentDelegate: false,
  authorities: {
    "mint-authority": "wallet-a",
    "metadata-authority": "wallet-a",
    "freeze-authority": "wallet-a",
    "permanent-delegate": "wallet-a",
  },
};

describe("localDraftsKey", () => {
  it("scopes drafts to the person, organization and project", async () => {
    const { localDraftsKey } = await import("./local-drafts.redesign");
    expect(localDraftsKey(scope, "project-a")).not.toBe(localDraftsKey(scope, "project-b"));
    expect(localDraftsKey(scope, null)).toBeNull();
  });
});

describe("local drafts", () => {
  const key = "sdp:issuance-local-drafts:v1:user:org:project";
  const entry = (id: string, name: string) => ({
    id,
    savedAt: "2026-10-01T09:00:00.000Z",
    step: 2,
    access: "blocklist" as const,
    draft: { ...fresh, name },
  });

  it("keeps the newest first, replaces a draft saved again, and survives a fresh page load", async () => {
    const firstPage = await import("./local-drafts.redesign");
    firstPage.saveLocalDraft(key, entry("one", "First"));
    firstPage.saveLocalDraft(key, entry("two", "Second"));
    firstPage.saveLocalDraft(key, entry("one", "First again"));

    vi.resetModules();
    const nextPage = await import("./local-drafts.redesign");
    expect(nextPage.readLocalDrafts(key).map((draft) => draft.draft.name)).toEqual([
      "First again",
      "Second",
    ]);
  });

  it("drops a removed draft and clears the key once none are left", async () => {
    const { readLocalDrafts, removeLocalDraft, saveLocalDraft } = await import(
      "./local-drafts.redesign"
    );
    saveLocalDraft(key, entry("one", "First"));
    removeLocalDraft(key, "one");
    expect(readLocalDrafts(key)).toEqual([]);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("ignores stored entries that are not drafts", async () => {
    window.localStorage.setItem(key, JSON.stringify([{ id: "x" }, entry("one", "First"), 7]));
    const { readLocalDrafts } = await import("./local-drafts.redesign");
    expect(readLocalDrafts(key).map((draft) => draft.id)).toEqual(["one"]);
  });
});

describe("restoreDraft", () => {
  it("takes stored fields of the right type and keeps keys only on wallets that still exist", async () => {
    const { restoreDraft } = await import("./local-drafts.redesign");
    const restored = restoreDraft(
      fresh,
      {
        assetClass: "digital-asset",
        name: "Treasury Fund",
        decimals: 9,
        pegCurrency: "EUR",
        permanentDelegate: true,
        authorities: { "mint-authority": "wallet-b", "freeze-authority": "gone" },
      },
      new Set(["wallet-a", "wallet-b"])
    );
    expect(restored.assetClass).toBe("digital-asset");
    expect(restored.name).toBe("Treasury Fund");
    expect(restored.decimals).toBe("6");
    expect(restored.pegCurrency).toBe("EUR");
    expect(restored.permanentDelegate).toBe(true);
    expect(restored.authorities["mint-authority"]).toBe("wallet-b");
    expect(restored.authorities["freeze-authority"]).toBe("wallet-a");
  });

  it("refuses values outside the draft's choices", async () => {
    const { restoreDraft } = await import("./local-drafts.redesign");
    const restored = restoreDraft(
      fresh,
      { assetClass: "security", pegCurrency: "JPY" },
      new Set(["wallet-a"])
    );
    expect(restored.assetClass).toBe("stablecoin");
    expect(restored.pegCurrency).toBeUndefined();
  });
});
