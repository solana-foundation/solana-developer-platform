import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import { createFeePaymentAdapter, isFeePaymentConfigured, resolveKoraEndpoint } from "./index";
import type { FeePaymentEnv } from "./port";

const DEVNET_KORA_URL = "https://kora-devnet.example";
const MAINNET_KORA_URL = "https://kora-mainnet.example";
const DEVNET_KORA_SIGNER = "So11111111111111111111111111111111111111112";
const MAINNET_KORA_SIGNER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";
const KORA_SIGNER_BY_URL = new Map([
  [DEVNET_KORA_URL, DEVNET_KORA_SIGNER],
  [MAINNET_KORA_URL, MAINNET_KORA_SIGNER],
]);

const DEVNET_ONLY: FeePaymentEnv = {
  KORA_RPC_URL_DEVNET: DEVNET_KORA_URL,
  KORA_API_KEY_DEVNET: "devnet-key",
  KORA_CLOUD_RUN_AUDIENCE_DEVNET: DEVNET_KORA_URL,
};

const BOTH_CLUSTERS: FeePaymentEnv = {
  ...DEVNET_ONLY,
  KORA_RPC_URL_MAINNET: MAINNET_KORA_URL,
};

function inScope<TResult>(environment: SdpEnvironment, operation: () => TResult): TResult {
  return runInClusterScope({ projectId: null, environment }, operation);
}

async function answerPayerSigner(input: Parameters<typeof fetch>[0]): Promise<Response> {
  if (typeof input !== "string") {
    throw new Error("Expected the Kora client to fetch a string URL");
  }
  const signerAddress = KORA_SIGNER_BY_URL.get(input);
  if (signerAddress === undefined) {
    throw new Error(`Unexpected fetch to ${input}`);
  }
  return Response.json({ jsonrpc: "2.0", id: 1, result: { signer_address: signerAddress } });
}

describe("resolveKoraEndpoint", () => {
  it("serves each scope's cluster from its own trio, never borrowing another cluster's key or audience", () => {
    const env: FeePaymentEnv = {
      ...DEVNET_ONLY,
      KORA_RPC_URL_MAINNET: ` ${MAINNET_KORA_URL} `,
      KORA_API_KEY_MAINNET: "mainnet-key",
    };

    assert.deepEqual(
      inScope("sandbox", () => resolveKoraEndpoint(env)),
      { rpcUrl: DEVNET_KORA_URL, apiKey: "devnet-key", identityTokenAudience: DEVNET_KORA_URL }
    );
    assert.deepEqual(
      inScope("production", () => resolveKoraEndpoint(env)),
      { rpcUrl: MAINNET_KORA_URL, apiKey: "mainnet-key", identityTokenAudience: undefined }
    );
  });

  it("answers null for a cluster without its own Kora URL, whatever else is configured", () => {
    const blankMainnet: FeePaymentEnv = {
      ...DEVNET_ONLY,
      KORA_RPC_URL_MAINNET: "  ",
      KORA_API_KEY_MAINNET: "mainnet-key",
    };

    assert.equal(
      inScope("production", () => resolveKoraEndpoint(DEVNET_ONLY)),
      null
    );
    assert.equal(
      inScope("production", () => resolveKoraEndpoint(blankMainnet)),
      null
    );
    assert.equal(
      inScope("sandbox", () => resolveKoraEndpoint({})),
      null
    );
    assert.equal(
      inScope("production", () => isFeePaymentConfigured(DEVNET_ONLY)),
      false
    );
    assert.equal(
      inScope("sandbox", () => isFeePaymentConfigured(DEVNET_ONLY)),
      true
    );
  });
});

describe("createFeePaymentAdapter", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("builds concurrent scopes' adapters against each scope cluster's own Kora", async () => {
    const fetchMock = mock.method(globalThis, "fetch", answerPayerSigner);

    const [devnetFeePayer, mainnetFeePayer] = await Promise.all([
      inScope("sandbox", async () => {
        const adapter = createFeePaymentAdapter(BOTH_CLUSTERS, "sdp:v1:sandbox:test");
        await delay(5);
        return adapter.getFeePayer();
      }),
      inScope("production", async () => {
        await delay(1);
        const adapter = createFeePaymentAdapter(BOTH_CLUSTERS, "sdp:v1:production:test");
        return adapter.getFeePayer();
      }),
    ]);

    assert.equal(devnetFeePayer, DEVNET_KORA_SIGNER);
    assert.equal(mainnetFeePayer, MAINNET_KORA_SIGNER);
    assert.deepEqual(fetchMock.mock.calls.map((call) => call.arguments[0]).sort(), [
      DEVNET_KORA_URL,
      MAINNET_KORA_URL,
    ]);
  });

  it("refuses a scope whose cluster has no Kora", () => {
    assert.throws(
      () => inScope("production", () => createFeePaymentAdapter(DEVNET_ONLY, "sdp:v1:test")),
      {
        name: "FeePaymentError",
        code: "PROVIDER_NOT_AVAILABLE",
        message: "Kora is not configured for mainnet-beta: set KORA_RPC_URL_MAINNET",
      }
    );
  });

  it("refuses to pick a Kora outside a cluster scope", () => {
    assert.throws(() => createFeePaymentAdapter(BOTH_CLUSTERS, "sdp:v1:test"), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
  });

  it("serves every cluster with the native fee payer", () => {
    const native: FeePaymentEnv = { FEE_PAYMENT_PROVIDER: "native" };

    assert.equal(
      inScope("production", () => isFeePaymentConfigured(native)),
      true
    );
    assert.equal(
      inScope("production", () => createFeePaymentAdapter(native, "sdp:v1:test")).providerId,
      "native"
    );
  });
});
