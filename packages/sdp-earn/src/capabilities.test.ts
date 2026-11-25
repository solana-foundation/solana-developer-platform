import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  supportsVaultParRedemption,
  supportsVaultProviderOrderWithdraw,
  supportsVaultQueuedWithdraw,
} from "./capabilities";
import { EARN_PROVIDER_CLIENTS } from "./index";

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

describe("supportsVaultParRedemption", () => {
  const directMethods = {
    buildVaultDeposit: async () => ({}),
    readVaultPositions: async () => [],
    sponsoredPrograms: () => [],
  };

  it("requires the complete request, cancel, read, and lifecycle contract", () => {
    const partial = Object.assign(Object.create(EARN_PROVIDER_CLIENTS.veda), directMethods, {
      getParRedemptionOptions: async () => ({}),
      quoteParRedemption: async () => ({}),
      buildParRedemptionRequest: async () => ({}),
      buildParRedemptionCancel: async () => ({}),
      readParRedemptionRequest: async () => ({}),
    });
    assert.equal(supportsVaultParRedemption(partial), false);

    const complete = Object.assign(partial, {
      decodeParRedemptionLifecycleEvents: async () => [],
    });
    assert.equal(supportsVaultParRedemption(complete), true);
  });
});

describe("supportsVaultProviderOrderWithdraw", () => {
  const withdrawMethods = {
    buildVaultDeposit: async () => ({}),
    readVaultPositions: async () => [],
    sponsoredPrograms: () => [],
    buildVaultWithdrawal: async () => ({}),
  };

  it("keeps an ordinary withdrawal builder atomic by default", () => {
    const atomic = Object.assign(Object.create(EARN_PROVIDER_CLIENTS.veda), withdrawMethods);
    assert.equal(supportsVaultProviderOrderWithdraw(atomic), false);
  });

  it("recognizes the explicit provider-order settlement declaration", () => {
    const providerOrder = Object.assign(
      Object.create(EARN_PROVIDER_CLIENTS.veda),
      withdrawMethods,
      {
        vaultWithdrawalSettlement: "provider_order" as const,
      }
    );
    assert.equal(supportsVaultProviderOrderWithdraw(providerOrder), true);
  });

  it("does not advertise settlement without a withdrawal builder", () => {
    const declarationOnly = Object.assign(Object.create(EARN_PROVIDER_CLIENTS.veda), {
      vaultWithdrawalSettlement: "provider_order" as const,
    });
    assert.equal(supportsVaultProviderOrderWithdraw(declarationOnly), false);
  });
});
