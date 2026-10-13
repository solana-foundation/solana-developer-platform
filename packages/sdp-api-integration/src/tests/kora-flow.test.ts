import { apiTestSupport } from "@sdp/api/test-support";
import { signature } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SignerCheckApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  env,
  initIntegrationApiSuite,
  requestWithApiKey,
} from "../helpers/integration";
import {
  getIntegrationLaneKora,
  getIntegrationLaneRpc,
  laneRpcPoolEnvKeyPattern,
  requireIntegrationLaneRpc,
} from "../helpers/kora-lane";

const { createSigningService, getDb, SponsorshipBudgetRepository, TEST_ORG, TEST_PROJECT } =
  apiTestSupport;

const KORA_LIVE_SMOKE_PER_TRANSACTION_LAMPORTS = 20_000_000;
const KORA_LIVE_SMOKE_POLICY_OPERATOR = "kora-live-smoke";
const KORA_LIVE_SMOKE_POLICY_REASON =
  "Permit isolated live Kora smoke against the reviewed provider outflow ceiling";

function assertKoraLiveSmokeEnvConfigured() {
  const missing: string[] = [];
  if (env.RUN_INTEGRATION_TESTS !== "true") missing.push("RUN_INTEGRATION_TESTS=true");
  if (!getIntegrationLaneRpc()) missing.push(laneRpcPoolEnvKeyPattern());
  const laneKora = getIntegrationLaneKora();
  if (!laneKora.rpcUrl) missing.push(laneKora.rpcUrlEnvKey);
  if (!env.PRIVY_APP_ID) missing.push("PRIVY_APP_ID");
  if (!env.PRIVY_APP_SECRET) missing.push("PRIVY_APP_SECRET");

  if (missing.length > 0) {
    throw new Error(`Kora live smoke tests require env configuration: ${missing.join(", ")}.`);
  }
}

describe("Kora Fee Payment (Live Smoke)", () => {
  const request = requestWithApiKey();
  let liveSmokePolicies: Awaited<
    ReturnType<InstanceType<typeof SponsorshipBudgetRepository>["resolvePolicies"]>
  >;

  beforeAll(async () => {
    assertKoraLiveSmokeEnvConfigured();
    await initIntegrationApiSuite();
    const repository = new SponsorshipBudgetRepository(getDb(env));
    for (const policy of [
      {
        scopeType: "global" as const,
        scopeId: null,
        hourlyLamports: 2_000_000_000,
        dailyLamports: 10_000_000_000,
      },
      {
        scopeType: "organization" as const,
        scopeId: TEST_ORG.id,
        hourlyLamports: 1_000_000_000,
        dailyLamports: 5_000_000_000,
      },
      {
        scopeType: "project" as const,
        scopeId: TEST_PROJECT.id,
        hourlyLamports: 1_000_000_000,
        dailyLamports: 3_000_000_000,
      },
    ]) {
      await repository.upsertPolicy({
        network: "devnet",
        ...policy,
        enabled: true,
        perTransactionLamports: KORA_LIVE_SMOKE_PER_TRANSACTION_LAMPORTS,
        operator: KORA_LIVE_SMOKE_POLICY_OPERATOR,
        reason: KORA_LIVE_SMOKE_POLICY_REASON,
      });
    }
    liveSmokePolicies = await repository.resolvePolicies({
      network: "devnet",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    await createSigningService(env).initializePrivySigning(TEST_ORG.id, TEST_PROJECT.id, {
      walletLabel: "Kora project root wallet",
    });
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  it("uses audited budget overrides for every live-smoke scope", () => {
    expect(liveSmokePolicies.map((policy) => policy.scopeType)).toEqual([
      "global",
      "organization",
      "project",
    ]);
    for (const policy of liveSmokePolicies) {
      expect(policy.perTransactionLamports).toBe(KORA_LIVE_SMOKE_PER_TRANSACTION_LAMPORTS);
      expect(policy.updatedBy).toBe(KORA_LIVE_SMOKE_POLICY_OPERATOR);
      expect(policy.updateReason).toBe(KORA_LIVE_SMOKE_POLICY_REASON);
    }
  });

  it("verifies a Privy signer-check memo in simulation without broadcasting", {
    timeout: 120000,
  }, async () => {
    const createWalletRes = await request("/v1/wallets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "privy",
        label: "Kora signer-check Privy integration wallet",
      }),
    });

    const createWalletPayload = await createWalletRes.text();
    if (createWalletRes.status !== 201) {
      throw new Error(
        `Privy wallet creation failed (${createWalletRes.status}): ${createWalletPayload}`
      );
    }

    const createWalletBody = JSON.parse(createWalletPayload) as {
      data: { wallet: { walletId: string; publicKey: string } };
    };

    const walletId = createWalletBody.data.wallet.walletId;
    const walletAddress = createWalletBody.data.wallet.publicKey;

    const createKeyRes = await request("/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Signer check integration key",
        permissions: ["wallets:write"],
        walletScope: "selected",
        signingWalletId: walletId,
      }),
    });

    expect(createKeyRes.status).toBe(201);
    const createdKeyBody = (await createKeyRes.json()) as {
      data: { apiKey: { id: string; key: string; name: string } };
    };

    const scopedApiKeyId = createdKeyBody.data.apiKey.id;
    const scopedApiKey = createdKeyBody.data.apiKey.key;
    const scopedApiKeyName = createdKeyBody.data.apiKey.name;
    const requestWithScopedKey = requestWithApiKey(scopedApiKey);
    let signerCheckPassed = false;

    try {
      const signerCheckRes = await requestWithScopedKey("/v1/wallets/signer-check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      const signerCheckPayload = await signerCheckRes.text();
      if (signerCheckRes.status !== 200) {
        throw new Error(
          `Kora signer-check failed (${signerCheckRes.status}): ${signerCheckPayload}`
        );
      }

      const signerCheckBody = JSON.parse(signerCheckPayload) as SignerCheckApiResponse;
      const signerCheck = signerCheckBody.data;

      expect(signerCheck.walletId).toBe(walletId);
      expect(signerCheck.walletAddress).toBe(walletAddress);
      expect(signerCheck.memo).toMatch(
        /^SDP signer check [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(signerCheck.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
      expect(signerCheck.feePayer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(signerCheck.feePayer).not.toBe(signerCheck.walletAddress);
      expect(signerCheck.simulated).toBe(true);
      expect(Date.parse(signerCheck.checkedAt)).not.toBeNaN();

      // The check runs in RPC simulation and must never broadcast: the
      // wallet's signature is real, but no transaction may exist on chain.
      const onChain = await requireIntegrationLaneRpc()
        .getTransaction(signature(signerCheck.signature), {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      expect(onChain).toBeNull();
      signerCheckPassed = true;
    } finally {
      const deleteScopedKeyRes = await request(`/v1/api-keys/${scopedApiKeyId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: scopedApiKeyName }),
      });
      if (signerCheckPassed) {
        expect(deleteScopedKeyRes.status).toBe(200);
      }
    }
  });
});
