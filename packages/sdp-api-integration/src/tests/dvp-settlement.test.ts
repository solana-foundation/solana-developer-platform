/**
 * Exercises DvP creation, custody funding, and balance readback over HTTP in
 * both leg directions. Uses real custody signing and chain transactions; it
 * does not fund the external leg or settle the trade.
 */

import { type ApiTestCustodyWallet, type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import { address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  createMosaicService,
  env,
  fundAddressToLamports,
  INTEGRATION_CUSTODY_PROVIDER,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
} from "../helpers/integration";

const { createOrgSigner, createSigningService, getDb } = apiTestSupport;

/** Covers the custody wallet's funding transaction and account rent. */
const WALLET_FUNDING_LAMPORTS = 2_000_000_000;
const ASSET_UNITS = 1_000;
const CASH_UNITS = 10;
const DECIMALS = 6;

/** The creator's view of one leg: party object, escrow, and funding standing. */
type DvpParty = {
  address: string;
  counterparty: { id: string; label: string } | null;
  wallet: { id: string; name: string | null } | null;
};

type DvpLeg = {
  party: DvpParty;
  escrow: string;
  funding: {
    observedAmount: string;
    funded: boolean;
    surplus: string | null;
    frozen: boolean;
  } | null;
  fundingSignature: string | null;
};

type DvpTrade = {
  id: string;
  status: string;
  kind: "agent" | "principal" | "bilateral";
  legs: { a: DvpLeg; b: DvpLeg };
};

type DvpTradeResponse = { data: { trade: DvpTrade } };
type DvpFundResponse = {
  data: { tradeId: string; leg: "a" | "b"; amount: string; signature: string };
};

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

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("DvP creation and funding", () => {
  const originalMarketsEnabled = env.MARKETS_ENABLED;
  let localPartyWallet: ApiTestCustodyWallet | undefined;

  beforeAll(async () => {
    env.MARKETS_ENABLED = "true";
    const state = await initIntegrationSuite();
    if (INTEGRATION_CUSTODY_PROVIDER === "local") {
      const signing = createSigningService(env as ApiTestEnv);
      localPartyWallet =
        (await signing.getWalletById(TEST_ORG.id, undefined, state.custodyWallet.id)) ?? undefined;
      if (!localPartyWallet) throw new Error("Local DvP party wallet was not initialized");
      await fundAddressToLamports(localPartyWallet.publicKey, WALLET_FUNDING_LAMPORTS);

      // Local custody has one key per config and cannot provision extra wallets.
      // Seed a separate project key as the authority; production providers still
      // exercise first-trade settlement-wallet provisioning through the route.
      const settlement = await signing.initializeLocalSigning(TEST_ORG.id, TEST_PROJECT.id, {
        walletLabel: "DvP settlement authority",
      });
      const db = getDb(env);
      const authority = await db
        .prepare(
          `UPDATE custody_wallets SET purpose = 'dvp_settlement_authority'
           WHERE custody_config_id = ? AND wallet_id = ? RETURNING id`
        )
        .bind(settlement.configId, settlement.walletId)
        .first<{ id: string }>();
      if (!authority) throw new Error("Local DvP settlement wallet was not initialized");
      await db
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(TEST_PROJECT.id, TEST_ORG.id, authority.id)
        .run();
      await fundAddressToLamports(settlement.publicKey, WALLET_FUNDING_LAMPORTS);
    } else {
      // First-trade provisioning mutates the project config without org fallback.
      await createSigningService(env as ApiTestEnv).initializePrivySigning(
        TEST_ORG.id,
        TEST_PROJECT.id,
        { walletLabel: "DvP project root" }
      );
    }
  });

  afterAll(async () => {
    env.MARKETS_ENABLED = originalMarketsEnabled;
    await cleanupIntegrationSuite();
  });

  // Both directions, identical assertions. Running only one is how the reverse
  // path stayed unexercised through every manual test.
  it.each(["a", "b"] as const)(
    "creates, funds and reads back a trade where SDP delivers leg %s",
    { timeout: 240_000 },
    async (side) => {
      const api = requestWithApiKey();
      const signer = await createOrgSigner(env as ApiTestEnv, TEST_ORG.id, TEST_PROJECT.id);
      const mosaic = createMosaicService(env as ApiTestEnv, signer, "sponsored", {
        environment: TEST_PROJECT.environment,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        actor: { type: "project", id: TEST_PROJECT.id },
      });

      const wallet =
        localPartyWallet ??
        (await createFundedIntegrationWallet({
          label: `dvp-leg-${side}`,
          fundLamports: WALLET_FUNDING_LAMPORTS,
        }));
      const externalPartyAddress = (await generateKeyPairSigner()).address;
      await fundAddressToLamports(externalPartyAddress, 1_000_000);

      // Distinct mints prove each direction funds the correct escrow.
      const [asset, cash] = await Promise.all([
        mosaic.createToken({
          template: "custom",
          feePayer: signer,
          metadata: { name: "Settlement Asset", symbol: "SETA", uri: "" },
          decimals: DECIMALS,
          mintAuthority: signer,
          freezeAuthority: null,
        }),
        mosaic.createToken({
          template: "custom",
          feePayer: signer,
          metadata: { name: "Settlement Cash", symbol: "SETC", uri: "" },
          decimals: DECIMALS,
          mintAuthority: signer,
          freezeAuthority: null,
        }),
      ]);

      if (!asset.mint || !cash.mint) throw new Error("Settlement fixture mints were not created");

      // Give the custody wallet exactly the tokens required for its leg.
      await mosaic.mintTo({
        mint: side === "a" ? asset.mint : cash.mint,
        destination: address(wallet.publicKey),
        amount: side === "a" ? ASSET_UNITS : CASH_UNITS,
        mintAuthority: signer.address, // Matches the signer bound to MosaicService above.
        feePayer: signer.address,
      });

      // The external address is distinct from all custody wallets, including
      // the one-key local fixture, so the caller is principal on exactly one leg.
      const partyA = side === "a" ? { walletId: wallet.id } : { address: externalPartyAddress };
      const partyB = side === "a" ? { address: externalPartyAddress } : { walletId: wallet.id };

      const created = await api("/v1/dvp/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyA,
          partyB,
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

      expect(created.status, await created.clone().text()).toBe(201);
      const trade = ((await created.json()) as DvpTradeResponse).data.trade;
      expect(trade.status).toBe("created");

      // The escrow addresses ARE the product: a counterparty pays into one with
      // an ordinary transfer, and nothing else.
      expect(trade.legs.a.escrow).toBeDefined();
      expect(trade.legs.b.escrow).toBeDefined();

      // The created trade answers with the derived read model: one custodied
      // leg — enriched with the caller's own wallet identity — one external,
      // so the caller stands as principal. Full-shape: a party field added
      // without a matching assertion here would pass.
      const custodiedParty = {
        address: wallet.publicKey,
        counterparty: null,
        wallet: { id: wallet.id, name: wallet.label },
      };
      const externalParty = { address: externalPartyAddress, counterparty: null, wallet: null };
      expect(trade.legs.a.party).toEqual(side === "a" ? custodiedParty : externalParty);
      expect(trade.legs.b.party).toEqual(side === "a" ? externalParty : custodiedParty);
      expect(trade.kind).toBe("principal");

      // Create observes both empty escrows, but neither leg has a funding receipt.
      const emptyFunding = {
        observedAmount: "0",
        funded: false,
        surplus: null,
        frozen: false,
      };
      expect(trade.legs.a.funding).toEqual(emptyFunding);
      expect(trade.legs.b.funding).toEqual(emptyFunding);
      expect(trade.legs.a.fundingSignature).toBeNull();
      expect(trade.legs.b.fundingSignature).toBeNull();

      const sdpEscrow = side === "a" ? trade.legs.a.escrow : trade.legs.b.escrow;
      const expected = BigInt(baseUnits(side === "a" ? ASSET_UNITS : CASH_UNITS));

      await expect(tokenBalance(sdpEscrow)).resolves.toBe(0n);

      // One fund endpoint for both parties: naming the side, the right to fund
      // is derived from holding a custody wallet at that side's party address.
      const funded = await api(`/v1/dvp/trades/${trade.id}/fund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
        timeoutMs: 90_000,
      });

      expect(funded.status, await funded.clone().text()).toBe(200);
      const fund = ((await funded.json()) as DvpFundResponse).data;
      expect(fund.tradeId).toBe(trade.id);
      expect(fund.leg).toBe(side);
      expect(fund.amount).toBe(baseUnits(side === "a" ? ASSET_UNITS : CASH_UNITS));
      expect(fund.signature).toBeTruthy();

      // The assertion that matters. A 200 says the request was accepted; only
      // the escrow balance says the tokens moved.
      await expect(tokenBalance(sdpEscrow)).resolves.toBe(expected);

      // Re-read through the API: the funded leg now names its funding receipt
      // and stands funded; the other leg still shows nothing happened.
      const reread = await api(`/v1/dvp/trades/${trade.id}`);
      expect(reread.status).toBe(200);
      const fresh = ((await reread.json()) as DvpTradeResponse).data.trade;
      expect(fresh.kind).toBe("principal");

      const fundedLeg = fresh.legs[side];
      expect(fundedLeg.fundingSignature).toBe(fund.signature);
      if (fundedLeg.funding === null) {
        throw new Error(`trade ${trade.id}: funded leg ${side} carries no observation`);
      }
      expect(fundedLeg.funding.observedAmount).toBe(fund.amount);
      expect(fundedLeg.funding.funded).toBe(true);
      expect(fundedLeg.funding.surplus).toBeNull();
    }
  );
});
