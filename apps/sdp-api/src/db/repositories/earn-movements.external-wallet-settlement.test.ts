import { earnProviderDepositSettlement } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import {
  createPostgresEarnMovementsRepository,
  generateEarnMovementId,
  generateEarnPositionId,
  queuedFulfillmentMovementId,
} from "./earn-movements.repository";

/**
 * Provider-aware settlement in the external-wallet earnings aggregate
 * (SOLA9-487).
 *
 * The aggregate must use the same settlement boundary as reconciliation: a
 * vault movement at `finalized` counts as settled only when its provider's
 * Solana leg is itself atomic, or when the row is an authenticated queued-
 * withdrawal fulfillment (`recordFulfilledQueueMovement` — the one writer that
 * finalizes a provider-order withdrawal WITH provider completion). A legacy
 * pre-0115 provider-order row stored as finalized — a WisdomTree subscription
 * whose chain leg reached finality before any authenticated provider-completion
 * path existed — must stay pending: excluded from the settled totals and
 * reported through `unsettledMovementCount` so `earned` is withheld
 * (`movements_pending`) instead of arithmetic that assumes money that has not
 * moved yet. Unknown providers fail closed the same way.
 */

const ORG = "org_earn_agg_settlement";
const PROJECT = "prj_earn_agg_settlement";
const USER = "usr_earn_agg_settlement";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SHARE = "So11111111111111111111111111111111111111112";

beforeEach(async () => {
  const db = getDb(env);
  await db.prepare("DELETE FROM earn_movements WHERE organization_id = ?").bind(ORG).run();
  await db.prepare("DELETE FROM earn_positions WHERE organization_id = ?").bind(ORG).run();
  await db.prepare("DELETE FROM projects WHERE organization_id = ?").bind(ORG).run();
  await db.prepare("DELETE FROM organizations WHERE id = ?").bind(ORG).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(USER).run();
  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(USER, "earn-aggregate-settlement@example.com")
    .run();
  await db
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORG, "Earnings aggregate settlement", "earn-aggregate-settlement", "enterprise", "active")
    .run();
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
});

async function seedPosition(provider: string, tokenMint: string, vaultAddress: string) {
  const positionId = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', ?, 'vault_direct', ?, ?, ?, ?, ?, sdp_iso_now())`
    )
    .bind(positionId, ORG, PROJECT, provider, OWNER, vaultAddress, SHARE, tokenMint, vaultAddress)
    .run();
  return positionId;
}

/**
 * One vault movement in the pre-0115 shape the migration repairs: a
 * provider-order row advanced all the way to `finalized`/`settled_at` by chain
 * finality alone. Valid 0062 commitment metadata (confirmed_at, settled_at,
 * amount_settled) so the row itself is honest about what the OLD writer knew.
 */
async function seedLegacyFinalizedMovement(input: {
  positionId: string;
  provider: string;
  direction: "deposit" | "withdrawal";
  tokenMint: string;
  vaultAddress: string;
  amount: string;
  id?: string;
  tokenAmountSettled?: string | null;
}) {
  const movementId = input.id ?? generateEarnMovementId();
  const observedAt = "2026-09-01T00:00:00.000Z";
  const [source, destination] =
    input.direction === "deposit" ? [OWNER, input.vaultAddress] : [input.vaultAddress, OWNER];
  await getDb(env)
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider, execution_model,
         direction, position_id, status, denomination, amount_requested, amount_settled,
         token_amount_settled, owner_address, vault_address, source_address,
         destination_address, signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint, created_at, confirmed_at, settled_at
       ) VALUES (?, ?, ?, 'sandbox', ?, 'vault_direct', ?, ?, 'finalized', ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, 'AQ==', '12345', ?, ?, ?, ?, ?)`
    )
    .bind(
      movementId,
      ORG,
      PROJECT,
      input.provider,
      input.direction,
      input.positionId,
      input.tokenMint,
      input.amount,
      input.amount,
      input.tokenAmountSettled ?? null,
      OWNER,
      input.vaultAddress,
      source,
      destination,
      `sig_${movementId}`,
      `request_${movementId}`,
      `fingerprint_${movementId}`,
      observedAt,
      observedAt,
      observedAt
    )
    .run();
  return movementId;
}

describe("aggregateExternalWalletMovements settlement boundary", () => {
  it("withholds a legacy finalized provider-order deposit while counting an atomic control", async () => {
    expect(earnProviderDepositSettlement("wisdomtree")).toBe("provider_order");
    expect(earnProviderDepositSettlement("kamino")).toBe("atomic");

    const providerOrderPosition = await seedPosition("wisdomtree", USDC, "vault-wisdomtree");
    const atomicPosition = await seedPosition("kamino", USDT, "vault-kamino");
    await seedLegacyFinalizedMovement({
      positionId: providerOrderPosition,
      provider: "wisdomtree",
      direction: "deposit",
      tokenMint: USDC,
      vaultAddress: "vault-wisdomtree",
      amount: "100",
    });
    await seedLegacyFinalizedMovement({
      positionId: atomicPosition,
      provider: "kamino",
      direction: "deposit",
      tokenMint: USDT,
      vaultAddress: "vault-kamino",
      amount: "100",
    });

    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: OWNER,
    });

    // The provider-order row's finality is the payment leg only: no
    // authenticated provider completion exists, so the deposit stays out of
    // the settled totals and the position reports a pending movement (which
    // withholds `earned` as `movements_pending`).
    expect(totals.get(providerOrderPosition)).toMatchObject({
      finalizedDeposits: "0",
      finalizedWithdrawals: "0",
      unsettledMovementCount: 1,
    });

    // Negative control: an atomic provider's finalized deposit is settlement.
    expect(totals.get(atomicPosition)).toMatchObject({
      finalizedDeposits: "100",
      finalizedWithdrawals: "0",
      unsettledMovementCount: 0,
    });
  });

  it("withholds a legacy finalized provider-order withdrawal the same way", async () => {
    const position = await seedPosition("wisdomtree", USDC, "vault-wisdomtree");
    await seedLegacyFinalizedMovement({
      positionId: position,
      provider: "wisdomtree",
      direction: "withdrawal",
      tokenMint: USDC,
      vaultAddress: "vault-wisdomtree",
      amount: "7",
      tokenAmountSettled: "6.5",
    });

    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: OWNER,
    });

    expect(totals.get(position)).toMatchObject({
      finalizedWithdrawals: "0",
      finalizedWithdrawalCount: 0,
      unvaluedWithdrawalCount: 0,
      unsettledMovementCount: 1,
    });
  });

  it("still counts an authenticated queued-withdrawal fulfillment as settled", async () => {
    // The one provider-order withdrawal that IS settled: the queue worker
    // finalizes it inside the same transaction that recorded provider
    // completion (advanceRequest -> fulfilled). Its id is the writer's own
    // key (`recordFulfilledQueueMovement` via queuedFulfillmentMovementId).
    const position = await seedPosition("veda", USDC, "vault-veda");
    const requestId = "req_agg_fulfillment";
    await seedLegacyFinalizedMovement({
      positionId: position,
      provider: "veda",
      direction: "withdrawal",
      tokenMint: USDC,
      vaultAddress: "vault-veda",
      amount: "3",
      id: queuedFulfillmentMovementId(requestId),
      tokenAmountSettled: "2.9",
    });

    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: OWNER,
    });

    expect(totals.get(position)).toMatchObject({
      finalizedWithdrawals: "2.9",
      finalizedWithdrawalCount: 1,
      unvaluedWithdrawalCount: 0,
      unsettledMovementCount: 0,
    });
  });

  it("fails closed for a finalized row whose provider is not in the registry", async () => {
    const position = await seedPosition("mystery_provider", USDC, "vault-mystery");
    await seedLegacyFinalizedMovement({
      positionId: position,
      provider: "mystery_provider",
      direction: "deposit",
      tokenMint: USDC,
      vaultAddress: "vault-mystery",
      amount: "50",
    });

    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: OWNER,
    });

    expect(totals.get(position)).toMatchObject({
      finalizedDeposits: "0",
      unsettledMovementCount: 1,
    });
  });
});
