import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInClusterScope } from "@sdp/rpc/scope";
import { assertKoraConfigured, createKoraAdapter, resolveKoraEndpoint } from "./index";
import { type FeePaymentEnv, FeePaymentError } from "./port";

type ScopeFacts = Parameters<typeof runInClusterScope>[0];

const SANDBOX: ScopeFacts = { projectId: "proj_fee_payment_sandbox", environment: "sandbox" };
const PRODUCTION: ScopeFacts = {
  projectId: "proj_fee_payment_production",
  environment: "production",
};

describe("resolveKoraEndpoint", () => {
  it("resolves the open scope's cluster's Kora and nothing from the other cluster's", () => {
    const bothClusters: FeePaymentEnv = {
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      KORA_DEVNET_API_KEY: "devnet-key",
      KORA_DEVNET_CLOUD_RUN_AUDIENCE: "https://kora-devnet.mock.invalid",
      KORA_MAINNET_URL: " https://kora-mainnet.mock.invalid ",
      KORA_MAINNET_API_KEY: "mainnet-key",
    };
    assert.deepEqual(
      runInClusterScope(SANDBOX, () => resolveKoraEndpoint(bothClusters)),
      {
        rpcUrl: "https://kora-devnet.mock.invalid",
        apiKey: "devnet-key",
        identityTokenAudience: "https://kora-devnet.mock.invalid",
      }
    );
    assert.deepEqual(
      runInClusterScope(PRODUCTION, () => resolveKoraEndpoint(bothClusters)),
      {
        rpcUrl: "https://kora-mainnet.mock.invalid",
        apiKey: "mainnet-key",
        identityTokenAudience: undefined,
      }
    );
  });

  it("answers null, and refuses an adapter, for a cluster without its Kora URL", () => {
    const devnetOnly: FeePaymentEnv = {
      KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
      KORA_MAINNET_URL: "   ",
      KORA_MAINNET_API_KEY: "mainnet-key",
      KORA_MAINNET_CLOUD_RUN_AUDIENCE: "https://kora-mainnet.mock.invalid",
    };
    runInClusterScope(PRODUCTION, () => {
      assert.equal(resolveKoraEndpoint(devnetOnly), null);
      assert.throws(
        () => createKoraAdapter(devnetOnly, "user_fee_payment_test"),
        (error: unknown) =>
          error instanceof FeePaymentError && error.code === "PROVIDER_NOT_AVAILABLE"
      );
    });
  });
});

describe("assertKoraConfigured", () => {
  it("refuses a cluster with only one of its two Kora URLs, naming the missing key", () => {
    assert.doesNotThrow(() =>
      assertKoraConfigured({
        KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
        KORA_DEVNET_RPC_URL: "https://kora-devnet-upstream.mock.invalid",
      })
    );
    assert.throws(
      () => assertKoraConfigured({ KORA_DEVNET_URL: "https://kora-devnet.mock.invalid" }),
      /Kora is half-configured for devnet: set KORA_DEVNET_RPC_URL/
    );
  });
});
