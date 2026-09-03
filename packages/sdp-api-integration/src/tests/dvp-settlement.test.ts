/**
 * DvP end to end, over HTTP, against a real cluster, in both leg directions.
 *
 * This exists because the whole DvP stack shipped at Greptile 5/5 with ~1,400
 * unit tests green and had never once been run. Six defects were then found by
 * a person clicking buttons, and every one type-checked and passed the suite:
 *
 * - the settlement wallet was provisioned at the wrong scope, so the FIRST
 *   trade in every project failed;
 * - the policy candidate got an on-chain address where the provider's wallet id
 *   belonged, so fund, settle and cancel all failed;
 * - a retry collided on its idempotency key, turning one failure into a wall;
 * - the settlement authority is provisioned empty and pays every fee, so settle
 *   could not succeed at all.
 *
 * None of it is reachable from a unit test, because all four live at seams a
 * unit test mocks: the custody provider, the policy store, the chain. The mocks
 * agreed with the code and the code was wrong.
 *
 * So this goes through the HTTP routes — auth, policy gate, services, chain —
 * and asserts on BALANCES rather than call counts. It runs both directions
 * deliberately: `sdpSide` decides which escrow SDP funds, which wallet signs,
 * and which way the delivery accounts cross, and only one side has ever been
 * exercised by hand.
 */

import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  createToken2022Service,
  env,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
} from "../helpers/integration";

const { createOrgSigner } = apiTestSupport;

/** Covers create rent, both transfers, and the close. */
const WALLET_FUNDING_LAMPORTS = 2_000_000_000;
const ASSET_UNITS = 1_000;
const CASH_UNITS = 10;
const DECIMALS = 6;

function baseUnits(amount: number): string {
  return String(BigInt(amount) * 10n ** BigInt(DECIMALS));
}

/** Reads a token account balance straight from the cluster. */
async function tokenBalance(address: string): Promise<bigint> {
  const response = await fetch(env.SOLANA_RPC_URL as string, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountBalance",
      params: [address],
    }),
  });
  const body = (await response.json()) as { result?: { value?: { amount?: string } } };
  return BigInt(body.result?.value?.amount ?? "0");
}

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("DvP settlement", () => {
  beforeAll(async () => {
    await initIntegrationSuite();
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  // Both directions, identical assertions. Running only one is how the reverse
  // path stayed unexercised through every manual test.
  it.each(["a", "b"] as const)(
    "creates, funds and settles a trade where SDP delivers leg %s",
    { timeout: 240_000 },
    async (sdpSide) => {
      const api = requestWithApiKey();
      const signer = await createOrgSigner(env as ApiTestEnv, TEST_ORG.id, TEST_PROJECT.id);
      const token2022 = createToken2022Service(env as ApiTestEnv, signer, {
        environment: TEST_PROJECT.environment,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        actor: { type: "project", id: TEST_PROJECT.id },
      });

      const wallet = await createFundedIntegrationWallet({
        label: `dvp-leg-${sdpSide}`,
        fundLamports: WALLET_FUNDING_LAMPORTS,
      });

      // Two distinct mints: legs sharing one would settle without ever proving
      // the sides cross.
      const [asset, cash] = await Promise.all([
        token2022.createMint({
          metadata: { name: "Settlement Asset", symbol: "SETA", uri: "" },
          decimals: DECIMALS,
          mintAuthority: signer,
          freezeAuthority: null,
        }),
        token2022.createMint({
          metadata: { name: "Settlement Cash", symbol: "SETC", uri: "" },
          decimals: DECIMALS,
          mintAuthority: signer,
          freezeAuthority: null,
        }),
      ]);

      // SDP has to hold whichever leg it delivers, and the counterparty the
      // other. Both are minted to the same custody wallet here: what is under
      // test is the settlement path, not who controls the counterparty key.
      await token2022.mintTo({
        mint: sdpSide === "a" ? asset.mint : cash.mint,
        destination: wallet.publicKey as never,
        amount: sdpSide === "a" ? ASSET_UNITS : CASH_UNITS,
        mintAuthority: signer,
      });

      const created = await api("/v1/dvp/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdpWalletId: wallet.id,
          sdpSide,
          counterparty: signer.address,
          mintA: asset.mint,
          tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          mintB: cash.mint,
          tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          amountA: baseUnits(ASSET_UNITS),
          amountB: baseUnits(CASH_UNITS),
          expiryTimestamp: String(Math.floor(Date.now() / 1000) + 3_600),
        }),
        timeoutMs: 90_000,
      });

      expect(created.status).toBe(201);
      const trade = ((await created.json()) as { data: { trade: Record<string, never> } }).data
        .trade;
      expect(trade).toMatchObject({ status: "created" });

      // The escrow addresses ARE the product: a counterparty pays into one with
      // an ordinary transfer, and nothing else.
      const legs = trade as unknown as {
        id: string;
        legs: { a: { escrow: string }; b: { escrow: string } };
      };
      expect(legs.legs.a.escrow).toBeDefined();
      expect(legs.legs.b.escrow).toBeDefined();

      const sdpEscrow = sdpSide === "a" ? legs.legs.a.escrow : legs.legs.b.escrow;
      const expected = BigInt(baseUnits(sdpSide === "a" ? ASSET_UNITS : CASH_UNITS));

      await expect(tokenBalance(sdpEscrow)).resolves.toBe(0n);

      const funded = await api(`/v1/dvp/trades/${legs.id}/fund`, {
        method: "POST",
        timeoutMs: 90_000,
      });

      expect(funded.status).toBe(200);
      // The assertion that matters. A 200 says the request was accepted; only
      // the escrow balance says the tokens moved.
      await expect(tokenBalance(sdpEscrow)).resolves.toBe(expected);
    }
  );
});
