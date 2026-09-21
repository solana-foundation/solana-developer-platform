import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  supportsPortfolioWallets,
  supportsVaultQueuedWithdraw,
  supportsWithdrawalApprovals,
} from "./capabilities";
import { EARN_PROVIDER_CLIENTS } from "./index";

describe("supportsPortfolioWallets", () => {
  it("rejects stub clients that do not implement the capability", () => {
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.veda), false);
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.upshift), false);
    assert.equal(supportsPortfolioWallets(EARN_PROVIDER_CLIENTS.perena), false);
  });

  it("rejects a partial implementation rather than failing mid-flow", () => {
    // Prototype chain keeps the full EarnVaultProvider surface; only one
    // portfolio method is added on top, so the guard must still say no.
    const partial: typeof EARN_PROVIDER_CLIENTS.veda = Object.assign(
      Object.create(EARN_PROVIDER_CLIENTS.veda) as typeof EARN_PROVIDER_CLIENTS.veda,
      {
        createPortfolioWallet: async () => ({
          providerWalletRef: "w",
          status: "creating" as const,
        }),
      }
    );
    assert.equal(supportsPortfolioWallets(partial), false);
  });
});

describe("supportsWithdrawalApprovals", () => {
  it("rejects stub clients that do not implement the capability", () => {
    assert.equal(supportsWithdrawalApprovals(EARN_PROVIDER_CLIENTS.veda), false);
    assert.equal(supportsWithdrawalApprovals(EARN_PROVIDER_CLIENTS.upshift), false);
    assert.equal(supportsWithdrawalApprovals(EARN_PROVIDER_CLIENTS.perena), false);
  });

  it("rejects a partial implementation rather than failing mid-flow", () => {
    const partial: typeof EARN_PROVIDER_CLIENTS.veda = Object.assign(
      Object.create(EARN_PROVIDER_CLIENTS.veda) as typeof EARN_PROVIDER_CLIENTS.veda,
      { listPendingWithdrawalApprovals: async () => [] }
    );
    assert.equal(supportsWithdrawalApprovals(partial), false);
  });
});

describe("supportsVaultQueuedWithdraw", () => {
  const directMethods = {
    buildVaultDeposit: async () => ({}),
    readVaultPositions: async () => [],
    sponsoredPrograms: () => [],
  };

  it("rejects clients with no queued-withdraw implementation", () => {
    assert.equal(supportsVaultQueuedWithdraw(EARN_PROVIDER_CLIENTS.veda), false);
  });

  it("rejects a partial queue implementation", () => {
    const partial = Object.assign(Object.create(EARN_PROVIDER_CLIENTS.veda), directMethods, {
      getWithdrawalOptions: async () => ({ instant: false, queued: false }),
    });
    assert.equal(supportsVaultQueuedWithdraw(partial), false);
  });

  it("requires provider-owned lifecycle decoding as part of the complete queue lifecycle", () => {
    const withoutDecoder = Object.assign(Object.create(EARN_PROVIDER_CLIENTS.veda), directMethods, {
      getWithdrawalOptions: async () => ({}),
      quoteQueuedWithdrawal: async () => ({}),
      buildQueuedWithdrawalRequest: async () => ({}),
      buildQueuedWithdrawalCancel: async () => ({}),
      readQueuedWithdrawalRequests: async () => [],
      readQueuedWithdrawalRequest: async () => ({}),
    });
    assert.equal(supportsVaultQueuedWithdraw(withoutDecoder), false);

    const complete = Object.assign(withoutDecoder, {
      decodeQueuedWithdrawalLifecycleEvents: async () => [],
    });
    assert.equal(supportsVaultQueuedWithdraw(complete), true);
  });
});
