import { afterEach, describe, expect, it, vi } from "vitest";
import { type EarnFundingWallet, fetchFundingWallets } from "./earn-funding-wallets";

afterEach(() => {
  vi.unstubAllGlobals();
});

function wallet(overrides: Partial<EarnFundingWallet> & { id: string }): EarnFundingWallet {
  return {
    walletId: `provider-${overrides.id}`,
    publicKey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    label: null,
    purpose: null,
    status: "active",
    isRuntimeExecutionAllowed: true,
    ...overrides,
  };
}

function stubResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body))
  );
}

describe("fetchFundingWallets", () => {
  it("fails closed when a successful response omits the wallet collection", async () => {
    stubResponse({ data: {} });
    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("fails closed on a row missing the address a deposit is signed from", async () => {
    // The cast this replaced let such a row through as a complete wallet.
    const { publicKey: _omitted, ...incomplete } = wallet({ id: "active" });
    stubResponse({ data: { wallets: [incomplete] } });
    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("returns only active wallets from the live response", async () => {
    const active = wallet({ id: "active" });
    stubResponse({
      data: { wallets: [active, wallet({ id: "inactive", status: "inactive" })] },
    });

    await expect(fetchFundingWallets()).resolves.toEqual([active]);
  });
});
