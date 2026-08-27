import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import type {
  EarnExternalWalletDepositResponse,
  EarnExternalWalletDepositTransactionResponse,
  EarnExternalWalletMovement,
  EarnExternalWalletWithdrawalResponse,
  EarnExternalWalletWithdrawalTransactionResponse,
  EarnVaultDirectMovementStatus,
} from "@sdp/types";
import { earnDepositStyle, isVaultDirectDepositEnabled } from "@sdp/types/provider-access";
import type { z } from "zod";
import { getDb } from "@/db";
import type { EarnExternalWalletTransactionRow } from "@/db/repositories/earn-external-wallet-transactions.repository";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  type ExternalWalletSubmitResult,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
} from "@/services/earn/vault-external-wallet.service";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { getEarnRepository, resolveSdpEnvironment } from "../context";
import type {
  earnExternalWalletDepositTransactionSchema,
  earnExternalWalletSubmitSchema,
  earnExternalWalletWithdrawalTransactionSchema,
} from "../schemas";
import { assertStrategyDepositable } from "./admission";

/**
 * External-wallet (caller-signed) vault flows — the B2B2C money path (PRO-1722).
 *
 * An external wallet is a NON-CUSTODIAL wallet the partner's platform
 * connects. SDP holds no key for it, so each direction is two calls: a BUILD
 * that returns an unsigned transaction for that wallet to sign, and a SUBMIT
 * that takes the signed bytes back, records the movement, then broadcasts.
 *
 * WHY NO POLICY GATE, stated here because its absence looks like the deposit
 * route's cautionary tale: wallet policy governs the organization's own
 * custody — every rule scopes to a custody wallet, and enforcement exists to
 * stand between a request and `createOrgSigner`. This path never resolves a
 * signer, never touches custody, and moves the OWNER's money on the OWNER's
 * signature, which IS the authorization. There is no signing sink here
 * for the value-moving conformance inventory to find.
 *
 * WHY THE BUILD IS THE GATE MOMENT: the money-in gates below run when SDP
 * builds, not again at submit. A signed transaction is only valid within its
 * blockhash window (about a minute), so the drift a submit-time re-check could
 * catch is bounded by that window — and a partner already holding signed
 * bytes could broadcast them itself regardless; what SDP controls is what it
 * is willing to BUILD, and what it records when the result comes back.
 */

type EarnExternalWalletDepositTransactionBody = z.output<
  typeof earnExternalWalletDepositTransactionSchema
>;
type EarnExternalWalletWithdrawalTransactionBody = z.output<
  typeof earnExternalWalletWithdrawalTransactionSchema
>;
type EarnExternalWalletSubmitBody = z.output<typeof earnExternalWalletSubmitSchema>;

/**
 * POST /v1/earn/external-wallet/deposit-transactions — build one unsigned deposit
 * transaction for an external wallet.
 *
 * MONEY-IN GATES, in the same order and with the same meaning as
 * `POST /vault-deposits` (routes/earn/CLAUDE.md → "Gate asymmetry"): opening a
 * position is a new commitment whoever signs it, so the environment
 * capability, the production slippage floor, surfacing, entitlement and
 * catalogue admission all apply unchanged. What is deliberately absent is
 * everything custody-shaped: no wallet resolution, no binding checks, no
 * policy extraction — the owner is an ADDRESS, not a wallet SDP can reach.
 */
export async function createEarnExternalWalletDepositTransaction(
  c: ValidatedBodyContext<typeof earnExternalWalletDepositTransactionSchema>
) {
  const body: EarnExternalWalletDepositTransactionBody = c.req.valid("json");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  // ENVIRONMENT CAPABILITY first, same constant as the custody deposit: what
  // keeps production vault deposits closed (PRO-1703) is not custody-shaped,
  // so the caller-signed path must not slip past it.
  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Vault deposits are not available in production yet: vault positions are not surfaced " +
        "on the Active tab, so a position opened here would sit outside the portfolio view."
    );
  }

  // SLIPPAGE FLOOR, required wherever real money moves — see the custody
  // deposit for the full rationale. It matters MORE here: the signer is a
  // stranger's wallet, so nothing else stands between a stale vault state and
  // the legacy no-floor instruction.
  if (environment === "production" && body.minSharesOut === undefined) {
    throw badRequest(
      "minSharesOut is required for a production vault deposit: without a floor the pinned " +
        "Kamino SDK builds the legacy deposit instruction, which accepts any number of shares."
    );
  }

  const strategy = await getEarnRepository(c).getStrategyById(body.strategyId);
  if (!strategy || strategy.environment !== environment) {
    throw notFound("Earn strategy");
  }
  const tokenMint = strategy.deposit_mints[0];
  if (!tokenMint) {
    throw internalError(`Earn strategy ${strategy.id} has no deposit mint`);
  }
  const shareMint = strategy.share_mint;
  if (!shareMint) {
    throw internalError(`Earn strategy ${strategy.id} has no share mint`);
  }

  if (earnDepositStyle(strategy.provider) !== "vault_direct") {
    throw badRequest(
      `${strategy.provider} is a custodial provider; external-wallet deposits are vault-direct only.`
    );
  }
  if (!isEarnProviderId(strategy.provider)) {
    throw providerNotConfigured(
      `Earn provider ${strategy.provider} is not available in this deployment`
    );
  }
  const provider = strategy.provider;

  assertEarnProviderSurfaced(provider);
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    provider,
    environment === "sandbox"
  );
  assertStrategyDepositable(strategy, environment);

  const built = await buildExternalWalletDepositTransaction(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    provider,
    providerReference: strategy.provider_reference,
    ownerAddress: body.ownerAddress,
    tokenMint,
    shareMint,
    label: strategy.name,
    amount: body.amount,
    minSharesOut: body.minSharesOut,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

  const response: EarnExternalWalletDepositTransactionResponse = {
    transaction: {
      ...toExternalWalletTransactionWire(built),
      amount: built.amount_requested,
      minSharesOut: built.min_shares_out,
      strategy: {
        id: strategy.id,
        name: strategy.name,
        provider: strategy.provider,
        providerReference: strategy.provider_reference,
        hostCluster: strategy.host_cluster,
      },
    },
  };
  return success(c, response);
}

/**
 * POST /v1/earn/external-wallet/withdrawal-transactions — build one unsigned exit
 * transaction for an external-wallet position.
 *
 * ADR 0002 exit safety, the same strongest form as `POST /vault-withdrawals`:
 * no surfacing, no entitlement, no availability, no environment capability,
 * no catalogue lookup. The caller names its own POSITION, which carries the
 * vault, the owner and both mints, so a delisted vault or an un-offered
 * provider stays exitable; capability (501, inside the service) is the only
 * provider-shaped refusal left.
 *
 * Scoping answers 404 across the board: organization and environment in the
 * position query, kind and owner shape (a custody position is not an
 * external-wallet position), and EXACT project — the external wallet is scoped to the partner
 * org AND project (PRO-1722), so a sibling project must not learn the
 * position exists, let alone exit it. This is deliberately stricter than the
 * custody exit, where sibling projects legitimately share org-level wallets.
 */
export async function createEarnExternalWalletWithdrawalTransaction(
  c: ValidatedBodyContext<typeof earnExternalWalletWithdrawalTransactionSchema>
) {
  const body: EarnExternalWalletWithdrawalTransactionBody = c.req.valid("json");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const positionRow = await repo.getPositionById({
    organizationId: auth.organizationId,
    environment,
    positionId: body.positionId,
  });
  const position = toExternalWalletHolding(positionRow, projectId);
  if (!position) {
    throw notFound("Earn external-wallet position");
  }

  const built = await buildExternalWalletWithdrawalTransaction(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    provider: position.provider,
    positionId: position.id,
    vaultAddress: position.vaultAddress,
    tokenMint: position.tokenMint,
    shareMint: position.shareMint,
    ownerAddress: position.ownerAddress,
    label: position.label,
    shareAtaRentFunder: position.shareAtaRentFunder,
    shares: body.shares,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

  const response: EarnExternalWalletWithdrawalTransactionResponse = {
    transaction: {
      ...toExternalWalletTransactionWire(built),
      positionId: position.id,
      shares: built.amount_requested,
    },
  };
  return success(c, response);
}

/**
 * POST /v1/earn/external-wallet/deposits — submit the signed deposit transaction.
 *
 * `Idempotency-Key` is REQUIRED, exactly as on the custody vault routes and
 * for the same reason: the chain has no request dedupe, and the recorded
 * movement is what answers a retry. The submit additionally consumes its
 * named BUILD exactly once, so the two protections compose: a same-key retry
 * replays the movement, and a different-key resubmit of the same build is a
 * 409 instead of a second ledger row for one on-chain transaction.
 */
export async function createEarnExternalWalletDeposit(
  c: ValidatedBodyContext<typeof earnExternalWalletSubmitSchema>
) {
  const body: EarnExternalWalletSubmitBody = c.req.valid("json");
  const requestId = requireExternalWalletIdempotencyKey(c, "external-wallet deposits");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const result = await submitExternalWalletDeposit(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    transactionId: body.transactionId,
    signedTransaction: body.signedTransaction,
    requestId,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

  const response: EarnExternalWalletDepositResponse = {
    deposit: toExternalWalletMovementWire(result),
  };
  return success(c, response);
}

/** POST /v1/earn/external-wallet/withdrawals — submit the signed exit transaction. */
export async function createEarnExternalWalletWithdrawal(
  c: ValidatedBodyContext<typeof earnExternalWalletSubmitSchema>
) {
  const body: EarnExternalWalletSubmitBody = c.req.valid("json");
  const requestId = requireExternalWalletIdempotencyKey(c, "external-wallet withdrawals");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const result = await submitExternalWalletWithdrawal(c.env, {
    organizationId: auth.organizationId,
    projectId,
    environment,
    transactionId: body.transactionId,
    signedTransaction: body.signedTransaction,
    requestId,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

  const response: EarnExternalWalletWithdrawalResponse = {
    withdrawal: toExternalWalletMovementWire(result),
  };
  return success(c, response);
}

function requireExternalWalletIdempotencyKey(c: AppContext, noun: string): string {
  // `Dry-Run: true` is a POLICY preview, honored only by the policy gate —
  // which these routes deliberately do not take. Without this refusal the
  // header would validate and then be silently ignored, and a caller who
  // learned dry-run on the custody routes would move real money here.
  if (isDryRunRequest(c)) {
    throw badRequest(
      `Dry-Run is not supported for ${noun}: there is no policy evaluation to preview here, ` +
        "and the submit would otherwise execute."
    );
  }
  const requestId = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  if (requestId === null) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for ${noun}`);
  }
  return requestId;
}

/** One external-wallet holding with its owner and instrument columns proven present. */
interface ExternalWalletHolding {
  id: string;
  provider: string;
  vaultAddress: string;
  label: string;
  ownerAddress: string;
  tokenMint: string;
  shareMint: string;
  shareAtaRentFunder: string | null;
}

/**
 * Narrow a position row to the external-wallet shape, or null. Everything that makes
 * this row NOT this caller's external-wallet holding answers identically: a custody
 * position (owner null), a custodial program, a sibling project's row, and a
 * genuinely missing id are all the same 404 upstream.
 */
function toExternalWalletHolding(
  row: EarnPositionRow | null,
  projectId: string
): ExternalWalletHolding | null {
  if (
    row?.kind !== "vault_direct" ||
    !row.owner_address ||
    row.project_id !== projectId ||
    !row.vault_address ||
    !row.token_mint ||
    !row.share_mint
  ) {
    return null;
  }
  return {
    id: row.id,
    provider: row.provider,
    vaultAddress: row.vault_address,
    label: row.label,
    ownerAddress: row.owner_address,
    tokenMint: row.token_mint,
    shareMint: row.share_mint,
    shareAtaRentFunder: row.share_ata_rent_funder,
  };
}

function toExternalWalletTransactionWire(built: EarnExternalWalletTransactionRow) {
  return {
    transactionId: built.id,
    transaction: built.unsigned_transaction,
    lastValidBlockHeight: built.last_valid_block_height,
    ownerAddress: built.owner_address,
    provider: built.provider,
    providerReference: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
  };
}

/**
 * Movement to wire, ledger vocabulary. This surface postdates the unified
 * ledger, so `finalized` keeps its own name and there is no legacy status
 * table to translate through.
 */
function toExternalWalletMovementWire(
  result: ExternalWalletSubmitResult
): EarnExternalWalletMovement {
  const movement: EarnMovementRow = result.movement;
  if (!movement.vault_address || !movement.signature || !movement.owner_address) {
    throw internalError(
      `Earn external-wallet movement ${movement.id} is missing execution details`
    );
  }
  return {
    movementId: movement.id,
    positionId: movement.position_id,
    provider: movement.provider,
    providerReference: movement.vault_address,
    direction: movement.direction,
    status: movement.status as EarnVaultDirectMovementStatus,
    signature: movement.signature,
    ownerAddress: movement.owner_address,
    amount: movement.amount_requested,
    denomination: movement.denomination,
    failureReason: movement.failure_reason,
    createdAt: movement.created_at,
    confirmedAt: movement.confirmed_at,
    settledAt: movement.settled_at,
    replayed: result.replayed,
  };
}
