import { runInClusterScope } from "@sdp/rpc/scope";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import type { EarnMovementDirection } from "@sdp/types/earn";
import {
  GENESIS_HASH_BY_CLUSTER,
  SPL_TOKEN_PROGRAMS,
  wellKnownMint,
} from "@sdp/types/well-known-tokens";
import { WISDOMTREE_FUNDS } from "@sdp/types/wisdomtree-programs";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { createPostgresEarnWalletTransactionsRepository } from "@/db/repositories/earn-wallet-transactions.repository";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { reconcileEarnProviderOrders } from "./provider-settlement.service";

const ORG = "org_wt_settlement";
const USER = "usr_wt_settlement";
const PROJECT = "prj_wt_settlement_production";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOURCE = getBase58Decoder().decode(new Uint8Array(64).fill(1));
const DESTINATION = getBase58Decoder().decode(new Uint8Array(64).fill(2));
const INITIAL = getBase58Decoder().decode(new Uint8Array(64).fill(3));

let sequence = 0;

beforeEach(async () => {
  await seedTestDatabase(env);
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "WT settlement", "wt-settlement", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "wt-settlement@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: "prj_wt_settlement_sandbox", production: PROJECT },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function scenario(direction: EarnMovementDirection) {
  const fund = WISDOMTREE_FUNDS[0];
  const usdc = wellKnownMint("USDC", "mainnet-beta");
  if (fund === undefined || usdc === undefined) throw new Error("Expected mainnet fund and USDC");
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const purchase = direction === "deposit";
  const builds = createPostgresEarnWalletTransactionsRepository(getDb(env));
  const build = async (buildDirection: EarnMovementDirection, positionId?: string) => {
    return builds.create({
      id: `wt-build-${crypto.randomUUID()}`,
      organizationId: ORG,
      projectId: PROJECT,
      environment: "production",
      provider: "wisdomtree",
      direction: buildDirection,
      ownerAddress: OWNER,
      vaultAddress: fund.mint,
      tokenMint: usdc,
      shareMint: fund.mint,
      label: fund.name,
      positionId,
      denomination: buildDirection === "deposit" ? usdc : fund.mint,
      amountRequested: buildDirection === "deposit" ? "100" : "2.5",
      createsShareAccount: false,
      unsignedTransaction: "AQID",
      lastValidBlockHeight: "100",
    });
  };
  const depositBuild = await build("deposit");
  const deposit = await ledger.createSignedWalletDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "production",
    provider: "wisdomtree",
    vaultAddress: fund.mint,
    ownerAddress: OWNER,
    walletTransactionId: depositBuild.id,
    shareMint: fund.mint,
    tokenMint: usdc,
    label: fund.name,
    requestedAmount: "100",
    signature: purchase ? SOURCE : INITIAL,
    signedTransaction: "AQID",
    lastValidBlockHeight: "100",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
  });
  let movement = deposit.movement;
  if (!purchase) {
    await ledger.advanceVaultMovement({
      movementId: movement.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "Independent existing holding",
    });
    const withdrawalBuild = await build("withdrawal", deposit.position.id);
    const withdrawal = await ledger.createSignedWalletWithdrawalIntent({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "production",
      provider: "wisdomtree",
      positionId: deposit.position.id,
      vaultAddress: fund.mint,
      ownerAddress: OWNER,
      walletTransactionId: withdrawalBuild.id,
      shareMint: fund.mint,
      requestedShares: "2.5",
      signature: SOURCE,
      signedTransaction: "BAUG",
      lastValidBlockHeight: "100",
      requestId: crypto.randomUUID(),
      idempotencyFingerprint: crypto.randomUUID(),
    });
    movement = withdrawal.movement;
  }
  const observedAt = new Date().toISOString();
  await ledger.advanceVaultMovement({
    movementId: movement.id,
    organizationId: ORG,
    toStatus: "confirmed",
    confirmedAt: observedAt,
  });
  await ledger.recordVaultMovementChainFinalization({
    movementId: movement.id,
    organizationId: ORG,
    observedAt,
  });

  sequence += 1;
  const rpcUrl = `https://wt-settlement-${sequence}.rpc.test`;
  vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", rpcUrl);
  const tokenMint = purchase ? fund.mint : usdc;
  const tokenProgram = purchase
    ? SPL_TOKEN_PROGRAMS["token-2022"]
    : SPL_TOKEN_PROGRAMS["spl-token"];
  const recipient = await deriveAssociatedTokenAddress(OWNER, tokenMint, tokenProgram);
  const amount = purchase ? "2500000000" : "2490000";
  const decimals = purchase ? fund.decimals : 6;
  let destinationVisible = false;
  let destinationAtoms = amount;
  const calls: { method: string; path: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (url.pathname === "/o/token/")
      return Response.json({ access_token: "test-wt-settlement", expires_in: 300 });
    if (url.pathname === `/api/orders/hash/${SOURCE}`)
      return Response.json({
        exchange_code: fund.exchangeCode,
        token_contract_address: fund.mint,
        blockchain: "Solana",
        trade_type: purchase ? "Purchase" : "Sale",
        order_type: "Primary",
        settlement_currency: "2",
        settlement_currency_name: "USDC",
        settlement_wallet_address: OWNER,
        status: "Settled",
        conversion_order_hash: purchase ? SOURCE : DESTINATION,
        deposit_hash: SOURCE,
        issuer_order_hash: purchase ? DESTINATION : null,
        token_amount: "2.5",
        net_value: "2.49",
      });
    if (url.toString() === `${rpcUrl}/`) {
      const request = parseJsonRpcRequest(init);
      if (request.method === "getGenesisHash")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: GENESIS_HASH_BY_CLUSTER["mainnet-beta"],
        });
      if (request.method === "getTransaction")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: destinationVisible
            ? {
                slot: 42,
                blockTime: 1790000000,
                transaction: {
                  signatures: [DESTINATION],
                  message: {
                    accountKeys: [{ pubkey: recipient, signer: false, writable: true }],
                    instructions: [
                      {
                        programId: tokenProgram,
                        parsed: { type: purchase ? "mintToChecked" : "transfer", info: {} },
                      },
                    ],
                  },
                },
                meta: {
                  err: null,
                  fee: 5000,
                  preBalances: [0],
                  postBalances: [0],
                  preTokenBalances: [],
                  postTokenBalances: [
                    {
                      accountIndex: 0,
                      mint: tokenMint,
                      owner: OWNER,
                      uiTokenAmount: {
                        amount: destinationAtoms,
                        decimals,
                        uiAmount: null,
                        uiAmountString: purchase ? "2.5" : "2.49",
                      },
                    },
                  ],
                  innerInstructions: [],
                },
              }
            : null,
        });
    }
    throw new Error(`Unexpected settlement request ${method} ${url.pathname}`);
  });
  const runtimeEnv = {
    ...env,
    WISDOMTREE_API_KEY: JSON.stringify({
      clientId: "wt-settlement-test",
      clientSecret: "test-only",
      username: `reader-${sequence}`,
      password: "test-only",
    }),
  };
  const poll = () =>
    runInClusterScope({ projectId: null, environment: "production" }, () =>
      reconcileEarnProviderOrders(runtimeEnv)
    );
  const read = () => ledger.getMovementById({ organizationId: ORG, movementId: movement.id });
  const allowRetry = () =>
    getDb(env)
      .prepare("UPDATE earn_movements SET reconciliation_attempted_at = NULL WHERE id = ?")
      .bind(movement.id)
      .run();
  return {
    poll,
    read,
    allowRetry,
    calls,
    deliver: () => {
      destinationVisible = true;
    },
    deliverAggregate: () => {
      destinationVisible = true;
      destinationAtoms = (BigInt(amount) * 2n).toString();
    },
  };
}

describe("WisdomTree through shared provider reconciliation", () => {
  it("keeps a combined credit pending instead of attributing it to one order", async () => {
    const flow = await scenario("deposit");
    flow.deliverAggregate();
    await flow.poll();
    expect(await flow.read()).toMatchObject({ status: "confirmed", settled_at: null });
  });

  it.each(["deposit", "withdrawal"] as const)(
    "keeps a finalized %s pending until its exact destination delivery is visible",
    async (direction) => {
      const flow = await scenario(direction);
      await flow.poll();
      expect(await flow.read()).toMatchObject({ status: "confirmed", settled_at: null });
      await flow.allowRetry();
      flow.deliver();
      await flow.poll();
      const settled = await flow.read();
      expect(settled).toMatchObject({ status: "finalized" });
      expect(settled?.settled_at).not.toBeNull();
      if (direction === "deposit") expect(settled?.shares_out).toBe("2.5");
      else expect(settled?.token_amount_settled).toBe("2.49");
      const observations = flow.calls.filter((call) => call.path.startsWith("/api/orders/"));
      expect(observations).toEqual([
        { method: "GET", path: `/api/orders/hash/${SOURCE}` },
        { method: "GET", path: `/api/orders/hash/${SOURCE}` },
      ]);
      await flow.poll();
      expect(flow.calls.filter((call) => call.path.startsWith("/api/orders/"))).toHaveLength(2);
      expect(flow.calls.filter((call) => call.method === "POST" && call.path !== "/")).toEqual([
        { method: "POST", path: "/o/token/" },
      ]);
    }
  );
});
