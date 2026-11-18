import { isEarnProviderId } from "@sdp/earn";
import { supportsVaultWithdrawQuote } from "@sdp/earn/capabilities";
import { notImplemented, providerNotConfigured } from "@sdp/earn/errors";
import type { EarnVaultWithdrawQuote } from "@sdp/earn/types";
import {
  addDecimalAmounts,
  subtractDecimalAmounts,
  sumDecimalAmounts,
} from "@sdp/payments/decimal";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  EarnDepositSwap,
  EarnVaultDirectMovementStatus,
  EarnWalletDepositResponse,
  EarnWalletDepositSwapSplitResponse,
  EarnWalletDepositTransactionResponse,
  EarnWalletEarnedUnavailableReason,
  EarnWalletEarnings,
  EarnWalletEarningsResponse,
  EarnWalletMovement,
  EarnWalletMovementResponse,
  EarnWalletMovementsPage,
  EarnWalletPosition,
  EarnWalletPositionSummary,
  EarnWalletPositionSummaryResponse,
  EarnWalletPositionsPage,
  EarnWalletTokenTotal,
  EarnWalletWithdrawalResponse,
  EarnWalletWithdrawalTransactionResponse,
} from "@sdp/types/earn";
import { isEarnVaultHoldingEmpty } from "@sdp/types/earn";
import { providerSettlementFromData } from "@sdp/types/earn-provider-orders";
import {
  earnDepositStyle,
  earnProviderDepositSettlement,
  earnProviderWithdrawalSettlement,
  earnWithdrawSlippageFloor,
} from "@sdp/types/provider-access";
import type { z } from "zod";
import { getDb } from "@/db/client";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnMovementsRepository,
  type EarnPositionRow,
  type WalletMovementTotals,
} from "@/db/repositories/earn-movements.repository";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { isEarnHastraDexExitConfigured } from "@/lib/feature-flags";
import { encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, requireEarnStrategyForCaller } from "@/routes/earn/context";
import { movementStatusOnWire } from "@/routes/earn/handlers/movement-settlement-wire";
import {
  type earnWalletDepositTransactionSchema,
  earnWalletEarningsQuerySchema,
  earnWalletMovementParamsSchema,
  earnWalletMovementsQuerySchema,
  earnWalletPositionSummaryQuerySchema,
  earnWalletPositionsQuerySchema,
  type earnWalletSubmitSchema,
  type earnWalletWithdrawalPreviewSchema,
  type earnWalletWithdrawalTransactionSchema,
} from "@/routes/earn/schemas";
import { getLogger } from "@/runtime/logger";
import { resolveVaultWithdrawClient } from "@/services/earn/execution-registry";
import type { JupiterSwapLeg } from "@/services/earn/jupiter-swap.service";
import { earnRuntime } from "@/services/earn/runtime";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { reconcileEarnVaultMovementReadThrough } from "@/services/earn/vault-movement-reconciliation.service";
import { rethrowVaultProviderFailure } from "@/services/earn/vault-refusals";
import {
  buildWalletDepositTransaction,
  buildWalletWithdrawalTransaction,
  submitWalletDeposit,
  submitWalletWithdrawal,
  type WalletBuildContext,
  type WalletBuiltTransaction,
} from "@/services/earn/vault-wallet.service";
import { assertDepositFloorPresent, assertVaultDepositAdmissible } from "./admission";
import {
  beginEarnDepositAudit,
  completeEarnDepositAudit,
  concludeEarnDepositAuditOnError,
  recordEarnWithdrawalAudit,
} from "./movement-audit";
import { decodeMovementCursor } from "./movements";
import { parseParams, parseQuery, resolveDepositSwapRequest } from "./shared";
import {
  decodeVaultPositionCursor,
  encodeVaultPositionCursor,
  type VaultPositionCursor,
} from "./vault-position-cursor";
import {
  closeEmptyHydratedPositions,
  type HydratedVaultPositionValue,
  hydratedHoldingTokenValue,
  hydrateVaultPositions,
  markVaultPositionRowsRead,
} from "./vault-position-hydration";

/**
 * Legacy owner-address signed submissions for existing integrations.
 *
 * The owner signs the exact prepared transaction. Fresh builds use core
 * operations; these handlers retain signed submissions, history and position
 * reads for the legacy URLs.
 *
 * WHY NO REQUEST GATE, stated here because its absence looks like the deposit
 * route's cautionary tale: a key's wallet scope governs the organization's
 * own custody, at `createOrgSignerForCustodyWallet` (HOO-2099). This path never resolves a signer, never
 * touches custody, and moves the OWNER's money on the OWNER's signature, which
 * IS the authorization. There is no signing sink here for the
 * value-moving conformance inventory to find.
 *
 * WHY THE BUILD IS THE GATE MOMENT: the money-in gates below run when SDP
 * builds. The vault exposure cap is the exception: the submit repeats the
 * decision under the ledger lock before recording or broadcasting. A signed
 * transaction is valid only within its blockhash window (about a minute), and
 * a caller already holding signed bytes can broadcast them without SDP; what
 * SDP controls is what it is willing to build, record and broadcast.
 */

type EarnWalletDepositTransactionBody = z.output<typeof earnWalletDepositTransactionSchema>;
type EarnWalletWithdrawalTransactionBody = z.output<typeof earnWalletWithdrawalTransactionSchema>;
type EarnWalletWithdrawalPreviewBody = z.output<typeof earnWalletWithdrawalPreviewSchema>;
type EarnWalletSubmitBody = z.output<typeof earnWalletSubmitSchema>;

const WALLET_POSITION_PAGE_SIZE = 100;
const MAX_IN_FLIGHT_WALLET_PORTFOLIOS = 256;

interface WalletPortfolioObservation {
  holdings: WalletHolding[];
  live: Map<string, HydratedVaultPositionValue>;
}

/**
 * Coalesce identical live portfolio reads while they are in flight.
 *
 * This is deliberately not a cache: the entry disappears as soon as the read
 * settles, so the next poll still observes fresh chain state. It only prevents
 * simultaneous dashboard loads or tabs on one instance from multiplying the
 * same database scan and provider fan-out.
 */
const inFlightWalletPortfolios = new Map<string, Promise<WalletPortfolioObservation>>();

/**
 * Legacy wallet summary: complete live portfolio for
 * one partner project, grouped by strategy and by token.
 *
 * The claim table is keyset-paged to the end before any total is returned. A
 * repeated or non-advancing cursor fails the request instead of serving a
 * plausible-looking partial total.
 */
export async function getEarnWalletPositionSummary(c: AppContext) {
  const { includeOwnerAddresses = false, includePositions = false } = parseQuery(
    c,
    earnWalletPositionSummaryQuerySchema
  );
  const { environment } = currentClusterScope();
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const portfolio = await observeWalletPortfolio(c, auth.organizationId, projectId, environment);
  const summary = summarizeWalletPositions(portfolio.holdings, portfolio.live, {
    includeOwnerAddresses,
    includePositions,
  });
  if (summary.unavailablePositionCount > 0) {
    getLogger().warn(
      {
        event: "sdp_api_earn_wallet_position_summary_unavailable",
        organization_id: auth.organizationId,
        project_id: projectId,
        environment,
        position_count: summary.positionCount,
        unavailable_position_count: summary.unavailablePositionCount,
      },
      "wallet position summary: live values unavailable"
    );
  }
  const response: EarnWalletPositionSummaryResponse = {
    summary,
  };
  return success(c, response);
}

function observeWalletPortfolio(
  c: AppContext,
  organizationId: string,
  projectId: string,
  environment: SdpEnvironment
): Promise<WalletPortfolioObservation> {
  const key = JSON.stringify([organizationId, projectId, environment]);
  const existing = inFlightWalletPortfolios.get(key);
  if (existing) return existing;

  const observation = loadWalletPortfolio(c, organizationId, projectId, environment);
  if (inFlightWalletPortfolios.size >= MAX_IN_FLIGHT_WALLET_PORTFOLIOS) {
    return observation;
  }
  inFlightWalletPortfolios.set(key, observation);
  const clear = () => {
    if (inFlightWalletPortfolios.get(key) === observation) {
      inFlightWalletPortfolios.delete(key);
    }
  };
  void observation.then(clear, clear);
  return observation;
}

async function loadWalletPortfolio(
  c: AppContext,
  organizationId: string,
  projectId: string,
  environment: SdpEnvironment
): Promise<WalletPortfolioObservation> {
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const rows = await collectAllWalletPositionRows((before) =>
    repo.listWalletPositions({
      organizationId,
      projectId,
      environment,
      limit: WALLET_POSITION_PAGE_SIZE,
      before,
    })
  );
  const rowsReadAt = markVaultPositionRowsRead();
  const holdings = rows.map((row) => requireWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, holdings.map(toHydratableHolding), {
    sourceType: "address",
    rowsReadAt,
  });
  await closeEmptyHydratedPositions(
    (positionId, observedUpdatedAt) =>
      repo.closeVaultPositionIfEmpty({
        positionId,
        organizationId,
        observedUpdatedAt,
      }),
    holdings,
    live
  );
  return { holdings, live };
}

/**
 * Legacy wallet positions: one owner's
 * holdings. The owner is a REQUIRED query filter, the same addressing every
 * per-owner read on this surface uses (see the movements list for the original
 * reasoning).
 *
 * A wallet with nothing in this project's scope answers an EMPTY page, never
 * 404: a partner's balance screen renders for a customer who has not deposited
 * yet, and the query is already org/project/environment scoped, so a wallet
 * claimed by another organization answers the same empty page (the caller
 * learns nothing it could not learn from the content).
 */
export async function listEarnWalletPositions(c: AppContext) {
  const query = parseQuery(c, earnWalletPositionsQuerySchema);
  const ownerAddress = query.ownerAddress;
  const before = query.before ? decodeVaultPositionCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid wallet position pagination cursor");
  }
  const { environment } = currentClusterScope();
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const page = await repo.listWalletPositions({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress,
    limit: query.limit,
    before,
  });
  const rowsReadAt = markVaultPositionRowsRead();
  const holdings = page.rows.map((row) => requireWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, holdings.map(toHydratableHolding), {
    sourceType: "address",
    rowsReadAt,
  });
  await closeEmptyHydratedPositions(
    (positionId, observedUpdatedAt) =>
      repo.closeVaultPositionIfEmpty({
        positionId,
        organizationId: auth.organizationId,
        observedUpdatedAt,
      }),
    holdings,
    live
  );
  const last = holdings.at(-1);
  const response: EarnWalletPositionsPage = {
    ownerAddress,
    positions: holdings.map((holding) => toWalletPositionWire(holding, live.get(holding.id))),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeVaultPositionCursor(last.createdAt, last.id) : null,
  };
  return success(c, response);
}

export async function collectAllWalletPositionRows(
  readPage: (
    before: VaultPositionCursor | null
  ) => Promise<{ rows: EarnPositionRow[]; hasMore: boolean }>
): Promise<EarnPositionRow[]> {
  const rows: EarnPositionRow[] = [];
  const seenBounds = new Set<string>();
  let before: VaultPositionCursor | null = null;

  while (true) {
    const result = await readPage(before);
    rows.push(...result.rows);
    if (!result.hasMore) return rows;

    const last = result.rows.at(-1);
    if (!last) {
      throw internalError("Wallet position pagination ended before completion");
    }
    const next = { createdAt: last.created_at, id: last.id };
    const key = JSON.stringify(next);
    if ((before && !cursorStrictlyPrecedes(next, before)) || seenBounds.has(key)) {
      throw internalError("Wallet position pagination did not advance");
    }
    seenBounds.add(key);
    before = next;
  }
}

function cursorStrictlyPrecedes(next: VaultPositionCursor, before: VaultPositionCursor): boolean {
  return (
    next.createdAt < before.createdAt ||
    (next.createdAt === before.createdAt && next.id < before.id)
  );
}

/**
 * Legacy wallet movements: one owner's activity, newest
 * first, in the ledger's own vocabulary (PRO-1772).
 *
 * The read the cross-provider feed structurally cannot serve: its vault arm
 * requires a custody-wallet match and an owner-signed row has none. Like every
 * movement read this takes NO provider gate (ADR 0002 — it reports on money
 * that already moved) and, like the position reads, no wallet scope: these
 * are end-user wallets SDP does not custody.
 *
 * The owner is a REQUIRED query filter, not a path segment, so the collection
 * keeps its `:movementId` detail route unambiguous. An owner with no recorded
 * movements in this exact project answers an EMPTY page, never 404 (same rule
 * as the positions read): every query is already org/project/environment
 * scoped, so "not yours" and "never seen" are the same empty answer.
 */
export async function listEarnWalletMovements(c: AppContext) {
  const query = parseQuery(c, earnWalletMovementsQuerySchema);
  const before = query.before ? decodeMovementCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid wallet movement pagination cursor");
  }
  const { environment } = currentClusterScope();
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const page = await repo.listWalletMovements({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress: query.ownerAddress,
    direction: query.direction,
    status: query.status,
    limit: query.limit,
    before,
  });
  const tokenMints = await resolveMovementTokenMints(repo, auth.organizationId, page.rows);
  const last = page.rows.at(-1);
  const response: EarnWalletMovementsPage = {
    ownerAddress: query.ownerAddress,
    movements: page.rows.map((row) =>
      toWalletMovementWire(row, requireMovementTokenMint(row, tokenMints))
    ),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
  };
  return success(c, response);
}

/**
 * The deposit-token mint behind each movement, from its position: a withdrawal
 * row carries only its SHARE mint, and the wire shape names the token unit a
 * feed renders in.
 */
async function resolveMovementTokenMints(
  repo: EarnMovementsRepository,
  organizationId: string,
  rows: readonly EarnMovementRow[]
): Promise<ReadonlyMap<string, string>> {
  return repo.listPositionTokenMints({
    organizationId,
    positionIds: rows.map((row) => row.position_id),
  });
}

function requireMovementTokenMint(
  movement: EarnMovementRow,
  tokenMints: ReadonlyMap<string, string>
): string {
  const tokenMint = tokenMints.get(movement.position_id);
  if (!tokenMint) {
    throw internalError(
      `Earn wallet movement ${movement.id} has no deposit-token mint on its position`
    );
  }
  return tokenMint;
}

function requirePositionTokenMint(position: EarnPositionRow): string {
  if (!position.token_mint) {
    throw internalError(`Earn wallet position ${position.id} has no deposit-token mint`);
  }
  return position.token_mint;
}

/**
 * Legacy wallet movement detail: poll one movement to a
 * terminal state, with a scoped, fail-soft read-through of its exact Solana
 * signature — the same interactive fast path the treasury detail reads take.
 *
 * This is what makes the submit's record-before-broadcast answerable on this
 * surface: the partner holds a movement id for a transaction whose fate it
 * never learned, and this poll observes the chain and advances the recorded
 * movement immediately; the scheduled reconciler stays the durable recovery
 * path for RPC outages and expiry. Scoping answers 404
 * across the board — organization, EXACT project, environment, and the
 * owner-address claim (a custody movement guessed by id is
 * indistinguishable from a missing row).
 */
export async function getEarnWalletMovement(c: AppContext) {
  const { movementId } = parseParams(c, earnWalletMovementParamsSchema);
  const { environment } = currentClusterScope();
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const row = await repo.getWalletMovement({
    organizationId: auth.organizationId,
    projectId,
    environment,
    movementId,
  });
  if (!row) throw notFound("Earn wallet movement");

  // The scope checks happen before the chain read so a guessed movement id
  // cannot use RPC timing to learn that another project's transaction exists.
  // The service's own post-write re-read is only organization-scoped, which is
  // fine here because this row already passed the four-rule scope above.
  const [currentMovement, tokenMints] = await Promise.all([
    reconcileEarnVaultMovementReadThrough(c.env, row),
    resolveMovementTokenMints(repo, auth.organizationId, [row]),
  ]);
  const response: EarnWalletMovementResponse = {
    movement: toWalletMovementWire(
      currentMovement,
      requireMovementTokenMint(currentMovement, tokenMints)
    ),
  };
  return success(c, response);
}

/**
 * Legacy wallet earnings: balance and total
 * earned for one end user, grouped by deposit token (PRO-1772).
 *
 * `earned` is live current value, plus the observed token payouts of
 * finalized withdrawals, minus finalized SDP deposits (chain for the first,
 * ledger for the other two), and it is stated only when it is exact. Five
 * things make it unstatable, each reported by name and none of them ever
 * coerced to zero:
 *
 * - a position's live value failed to hydrate (`live_value_unavailable`);
 * - a movement is still settling, so the chain and the ledger describe
 *   different moments (`movements_pending` — detail polling performs a bounded
 *   live chain read and the scheduled reconciler remains the recovery path);
 * - a queued withdrawal request is still open (`withdrawals_pending`): a Veda
 *   solver queue escrows the shares and a Hastra par redemption burns them, so
 *   live value falls short by the request before its payout is a ledger
 *   fact, until the request reaches a terminal status;
 * - a finalized deposit has no observed receipt (`deposits_not_valued`),
 *   leaving `totalDeposited` incomplete;
 * - a finalized withdrawal has NO observed payout (`withdrawals_not_valued`):
 *   exits are ledgered in SHARES, and the deposit-token payout is observed
 *   from the landed transaction at settlement (`token_amount_settled`,
 *   migration 0103); a row that predates that, or whose transaction read
 *   failed, leaves `totalWithdrawn` incomplete.
 *
 * A wallet with no positions in scope answers `positionCount: 0` and empty
 * totals, never 404 (same rule as the other per-owner reads).
 *
 * The ADR 0002 caveat applies at full strength: live hydration reads the
 * owner's WHOLE vault balance, so shares acquired outside SDP inflate
 * `currentValue` and therefore `earned`. That is the honest non-custodial
 * answer, documented rather than corrected — the chain cannot attribute
 * fungible shares to SDP movements.
 */
export async function getEarnWalletEarnings(c: AppContext) {
  const { ownerAddress } = parseQuery(c, earnWalletEarningsQuerySchema);
  const { environment } = currentClusterScope();
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const scope = { organizationId: auth.organizationId, projectId, environment };
  const [rows, movementTotals] = await Promise.all([
    collectAllWalletPositionRows((before) =>
      repo.listWalletPositions({
        ...scope,
        ownerAddress,
        limit: WALLET_POSITION_PAGE_SIZE,
        before,
      })
    ),
    repo.aggregateWalletMovements({ ...scope, ownerAddress }),
  ]);
  const rowsReadAt = markVaultPositionRowsRead();
  const holdings = rows.map((row) => requireWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, holdings.map(toHydratableHolding), {
    sourceType: "address",
    rowsReadAt,
  });
  await closeEmptyHydratedPositions(
    (positionId, observedUpdatedAt) =>
      repo.closeVaultPositionIfEmpty({
        positionId,
        organizationId: auth.organizationId,
        observedUpdatedAt,
      }),
    holdings,
    live
  );

  const response: EarnWalletEarningsResponse = {
    earnings: summarizeWalletEarnings(ownerAddress, holdings, live, movementTotals),
  };
  return success(c, response);
}

interface MutableTokenEarnings {
  tokenMint: string;
  positionCount: number;
  unavailablePositionCount: number;
  values: string[];
  deposits: string[];
  withdrawals: string[];
  earnedUnavailableReason?: EarnWalletEarnedUnavailableReason;
}

/**
 * Higher wins when several positions leave a token's earned unstatable. A
 * settling movement outranks an open request: it clears within the
 * reconciler's window, and the request's longer-lived reason then surfaces.
 */
const EARNED_UNAVAILABLE_PRIORITY: Record<EarnWalletEarnedUnavailableReason, number> = {
  cost_basis_unknown: 6,
  live_value_unavailable: 5,
  movements_pending: 4,
  withdrawals_pending: 3,
  deposits_not_valued: 2,
  withdrawals_not_valued: 1,
};

function summarizeWalletEarnings(
  ownerAddress: string,
  holdings: readonly WalletHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  movementTotals: ReadonlyMap<string, WalletMovementTotals>
): EarnWalletEarnings {
  const tokens = new Map<string, MutableTokenEarnings>();
  let unavailablePositionCount = 0;

  for (const holding of holdings) {
    const value = hydratedHoldingTokenValue(live.get(holding.id));
    if (value === undefined) unavailablePositionCount += 1;
    const totals = movementTotals.get(holding.id);

    let token = tokens.get(holding.tokenMint);
    if (!token) {
      token = {
        tokenMint: holding.tokenMint,
        positionCount: 0,
        unavailablePositionCount: 0,
        values: [],
        deposits: [],
        withdrawals: [],
      };
      tokens.set(holding.tokenMint, token);
    }
    token.positionCount += 1;
    if (value === undefined) token.unavailablePositionCount += 1;
    else token.values.push(value);
    if (totals) {
      token.deposits.push(totals.finalizedDeposits);
      token.withdrawals.push(totals.finalizedWithdrawals);
    }

    const reason =
      holding.costBasisKnown === false
        ? "cost_basis_unknown"
        : earnedUnavailableReason(value, totals);
    if (
      reason &&
      (!token.earnedUnavailableReason ||
        EARNED_UNAVAILABLE_PRIORITY[reason] >
          EARNED_UNAVAILABLE_PRIORITY[token.earnedUnavailableReason])
    ) {
      token.earnedUnavailableReason = reason;
    }
  }

  return {
    ownerAddress,
    positionCount: holdings.length,
    unavailablePositionCount,
    totalsByToken: [...tokens.values()]
      .map((token) => {
        const totalDeposited = sumDecimalAmounts(token.deposits);
        const totalWithdrawn = sumDecimalAmounts(token.withdrawals);
        const currentValue =
          token.unavailablePositionCount === 0 ? sumDecimalAmounts(token.values) : undefined;
        return {
          tokenMint: token.tokenMint,
          positionCount: token.positionCount,
          unavailablePositionCount: token.unavailablePositionCount,
          ...(currentValue === undefined ? {} : { currentValue }),
          totalDeposited,
          totalWithdrawn,
          // Σ(live_i + withdrawn_i − deposited_i) = Σlive + Σwithdrawn −
          // Σdeposited, so the token-level figure IS the per-position sum,
          // computed once, and only when every contributing position can
          // state it.
          ...(token.earnedUnavailableReason || currentValue === undefined
            ? { earnedUnavailableReason: token.earnedUnavailableReason ?? "live_value_unavailable" }
            : {
                earned: subtractDecimalAmounts(
                  addDecimalAmounts(currentValue, totalWithdrawn),
                  totalDeposited
                ),
              }),
        };
      })
      .sort((left, right) => compareWireStrings(left.tokenMint, right.tokenMint)),
  };
}

function earnedUnavailableReason(
  liveTokenValue: string | undefined,
  totals: WalletMovementTotals | undefined
): EarnWalletEarnedUnavailableReason | null {
  if (liveTokenValue === undefined) return "live_value_unavailable";
  if (totals && totals.unsettledMovementCount > 0) return "movements_pending";
  if (totals && totals.openWithdrawalRequestCount > 0) return "withdrawals_pending";
  if (totals && totals.unvaluedDepositCount > 0) return "deposits_not_valued";
  // A valued withdrawal is a ledger fact like a deposit; only an UNVALUED one
  // (no observed payout) leaves the figure inexact.
  if (totals && totals.unvaluedWithdrawalCount > 0) return "withdrawals_not_valued";
  return null;
}

interface AuthenticatedEarnRequest {
  auth: ApiKeyContext;
  projectId: string;
}

function getAuthenticatedEarnRequest(c: AppContext): AuthenticatedEarnRequest {
  return { auth: getAuth(c), projectId: requireProjectId(c) };
}

function toWalletBuildContext(request: AuthenticatedEarnRequest): WalletBuildContext {
  return {
    organizationId: request.auth.organizationId,
    projectId: request.projectId,
    userId: request.auth.userId ?? null,
    apiKeyId: request.auth.apiKeyId ?? null,
  };
}

export interface WalletExitLocator {
  positionId: string;
}

export interface ResolvedWalletExit {
  buildContext: WalletBuildContext;
  positionId: string;
  provider: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  ownerAddress: string;
  label: string;
  shareAtaRentFunder: string | null;
}

/**
 * Resolve one exit from the caller's tenant position: organization,
 * environment, wallet shape and exact project, each a 404 when it
 * does not match. The position carries the vault, owner and mints, so the exit
 * needs no catalogue row and a delisted vault stays exitable.
 */
export async function resolveWalletExit(
  c: AppContext,
  locator: WalletExitLocator
): Promise<ResolvedWalletExit> {
  const authenticated = getAuthenticatedEarnRequest(c);
  const { environment } = currentClusterScope();
  const positionRow = await createPostgresEarnMovementsRepository(getDb(c.env)).getPositionById({
    organizationId: authenticated.auth.organizationId,
    environment,
    positionId: locator.positionId,
  });
  const position = toWalletHolding(positionRow, authenticated.projectId);
  if (!position) throw notFound("Earn wallet position");
  return {
    buildContext: toWalletBuildContext(authenticated),
    provider: position.provider,
    positionId: position.id,
    vaultAddress: position.vaultAddress,
    tokenMint: position.tokenMint,
    shareMint: position.shareMint,
    ownerAddress: position.ownerAddress,
    label: position.label,
    shareAtaRentFunder: position.shareAtaRentFunder,
  };
}

/**
 * Retired HTTP deposit builder; not mounted by the Earn router.
 *
 * MONEY-IN GATES preserve the custody deposit order (routes/earn/CLAUDE.md,
 * "Gate asymmetry"): production slippage floor, environment capability,
 * surfacing, entitlement and catalogue admission. Everything custody-shaped
 * stays absent: no wallet resolution, wallet scope, or policy extraction.
 * The owner is an address, not a wallet SDP can reach.
 */
export async function createEarnWalletDepositTransaction(
  c: ValidatedBodyContext<typeof earnWalletDepositTransactionSchema>
) {
  const body: EarnWalletDepositTransactionBody = c.req.valid("json");
  const authenticated = getAuthenticatedEarnRequest(c);
  const { strategy, environment } = await requireEarnStrategyForCaller(c, body.strategyId);
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
      `${strategy.provider} is a custodial provider; wallet deposits are vault-direct only.`
    );
  }
  if (!isEarnProviderId(strategy.provider)) {
    throw providerNotConfigured(
      `Earn provider ${strategy.provider} is not available in this deployment`
    );
  }
  const provider = strategy.provider;

  // The share floor the catalogue promised (`depositSlippage`) is the one the
  // build enforces: every production deposit carries one, derived from the
  // provider's live quote and enforced by its on-chain instruction. A next-NAV
  // provider order publishes null because its later settlement cannot be
  // bounded by the on-chain payment leg.
  assertDepositFloorPresent(provider, environment, body.minSharesOut, strategy.host_cluster);

  // Surfacing, entitlement, catalogue admission and the SDP-wide exposure cap
  // (ADR 0004 layer 1), in the custody deposit's order and from the same
  // function, so the two money-in paths cannot drift. Entitlement applies
  // only when optional auth supplied an organization. The deposit style and
  // provider registration were already asserted above with this route's own
  // wording; the shared predicate re-checks them for free. `body.amount` is
  // the SOURCE stablecoin's units on a swap-funded build, which the cap treats
  // dollar-for-dollar by design.
  await assertVaultDepositAdmissible(c, strategy, body.amount);

  const swap = resolveDepositSwapRequest(
    {
      sourceTokenMint: body.sourceTokenMint,
      swapSlippageBps: body.swapSlippageBps,
    },
    tokenMint
  );

  // A fee payer equal to the owner IS the default: normalized away here so the
  // build, the compiled signer set, and the stored row all agree it is absent.
  const feePayer = body.feePayer === body.ownerAddress ? undefined : body.feePayer;

  const result = await buildWalletDepositTransaction(c.env, {
    ...toWalletBuildContext(authenticated),
    provider,
    strategyId: strategy.id,
    providerReference: strategy.provider_reference,
    ownerAddress: body.ownerAddress,
    feePayer,
    tokenMint,
    shareMint,
    label: strategy.name,
    amount: body.amount,
    minSharesOut: body.minSharesOut,
    ...(swap === null ? {} : { swap }),
  });

  if (result.kind === "swap_required") {
    // The composed swap + deposit exceeds one Solana packet even on a compact
    // route. Answer the split contract: an unsigned swap for the owner to
    // execute itself, plus the exact follow-up build to request afterwards.
    if (swap === null) {
      throw internalError("Earn deposit build reported a swap split without a swap request");
    }
    const response: EarnWalletDepositSwapSplitResponse = {
      requiresSeparateSwap: true,
      sponsored: false,
      swap: {
        ...toDepositSwapWire(swap.sourceTokenMint, result.swap),
        transaction: Buffer.from(result.swapTransaction.bytes).toString("base64"),
        lastValidBlockHeight: result.swapTransaction.lastValidBlockHeight,
      },
      followUp: {
        strategyId: strategy.id,
        amount: result.swap.minOutAmount,
        // The original floor survives the split: dropping it would hand a
        // production caller a follow-up contract its own build refuses (the
        // floor is required there), and elsewhere a floor-less rebuild on
        // Kamino's pinned SDK selects the legacy unprotected instruction.
        ...(body.minSharesOut === undefined ? {} : { minSharesOut: body.minSharesOut }),
        // The fee payer survives the split for the same reason: a follow-up
        // build that silently dropped it would bill the customer's wallet.
        ...(feePayer === undefined ? {} : { feePayer }),
      },
    };
    return success(c, response);
  }

  const built = result.built;
  const response: EarnWalletDepositTransactionResponse = {
    transaction: {
      ...toWalletTransactionWire(built),
      amount: built.amount_requested,
      minSharesOut: built.min_shares_out,
      ...(swap !== null && result.swap !== undefined
        ? { swap: toDepositSwapWire(swap.sourceTokenMint, result.swap) }
        : {}),
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

/** The swap leg restated in wire vocabulary, shared by both deposit answers. */
function toDepositSwapWire(sourceTokenMint: string, leg: JupiterSwapLeg): EarnDepositSwap {
  return {
    sourceTokenMint,
    sourceAmount: leg.sourceAmount,
    depositAmount: leg.minOutAmount,
    quotedAmount: leg.quotedAmount,
    slippageBps: leg.slippageBps,
    priceImpactPct: leg.priceImpactPct,
    routeLabels: leg.routeLabels,
  };
}

/**
 * Retired HTTP withdrawal builder; not mounted by the Earn router.
 *
 * ADR 0002 exit safety, the same strongest form as `POST /vault-withdrawals`:
 * no surfacing, entitlement, availability, or environment capability gate.
 * The caller names its position, which carries the vault, owner, and mints.
 * Capability (501, inside the service) is the only provider-shaped refusal
 * left.
 *
 * Scoping answers 404 across the board: organization and
 * environment in the position query, kind and owner shape, and exact project.
 * A sibling project must not learn whether the position exists. The custody
 * exit holds the same boundary: every custody wallet belongs to one project.
 */
export async function createEarnWalletWithdrawalTransaction(
  c: ValidatedBodyContext<typeof earnWalletWithdrawalTransactionSchema>
) {
  const body: EarnWalletWithdrawalTransactionBody = c.req.valid("json");
  const target = await resolveWalletExit(c, body);

  // Same provider-policy exit floor as the custody withdrawal: a non-null
  // `withdrawalSlippage` refuses a floor-less build (caller-fixable 400,
  // derived from the withdrawal preview — never an admission gate).
  const withdrawalFloor =
    target.provider === "hastra" && !isEarnHastraDexExitConfigured(c.env)
      ? null
      : earnWithdrawSlippageFloor(target.provider);
  if (body.minAmountOut === undefined && withdrawalFloor !== null) {
    throw badRequest(
      `minAmountOut is required for this withdrawal because ${target.provider} declares a withdrawal slippage policy.`
    );
  }

  // Same owner-is-the-default normalization as the deposit build.
  const feePayer = body.feePayer === target.ownerAddress ? undefined : body.feePayer;

  const built = await buildWalletWithdrawalTransaction(c.env, {
    ...target.buildContext,
    provider: target.provider,
    positionId: target.positionId,
    vaultAddress: target.vaultAddress,
    tokenMint: target.tokenMint,
    shareMint: target.shareMint,
    ownerAddress: target.ownerAddress,
    feePayer,
    label: target.label,
    shareAtaRentFunder: target.shareAtaRentFunder,
    shares: body.shares,
    redemptionMode: body.redemptionMode,
    ...(body.minAmountOut === undefined ? {} : { minAmountOut: body.minAmountOut }),
  });

  const response: EarnWalletWithdrawalTransactionResponse = {
    transaction: {
      ...toWalletTransactionWire(built),
      positionId: target.positionId,
      shares: built.amount_requested,
      minAmountOut: built.min_shares_out,
    },
  };
  return success(c, response);
}

/**
 * Legacy withdrawal preview: quote one caller-owned
 * exit without applying a custody wallet scope. The position's exact project
 * scope is the authorization boundary, matching the external build route.
 *
 * Like the build, this keeps every money-in gate out of the exit path. A
 * delisted strategy and a provider disabled for new deposits must remain
 * quotable and exitable. The quote is read-only and exists solely to derive a
 * caller-chosen minAmountOut from current vault accounting.
 */
export async function createEarnWalletWithdrawalPreview(
  c: ValidatedBodyContext<typeof earnWalletWithdrawalPreviewSchema>
) {
  const body: EarnWalletWithdrawalPreviewBody = c.req.valid("json");
  const target = await resolveWalletExit(c, body);

  const deadline = createVaultDeadline();
  const client = resolveVaultWithdrawClient(c.env, target.provider, deadline);
  if (!client || !supportsVaultWithdrawQuote(client)) {
    throw notImplemented(target.provider, "vault withdrawal quoting");
  }

  let quote: EarnVaultWithdrawQuote;
  try {
    quote = await client.quoteVaultWithdrawal(earnRuntime(c.env), {
      providerReference: target.vaultAddress,
      shares: body.shares,
    });
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }

  return success(c, {
    positionId: target.positionId,
    assetsOut: quote.assetsOut,
    assetDecimals: quote.assetDecimals,
    blockingIssues: quote.blockingIssues,
  });
}

/**
 * Legacy submit: verify and record an already-built signed deposit.
 *
 * `Idempotency-Key` is REQUIRED, exactly as on the custody vault routes and
 * for the same reason: the chain has no request dedupe, and the recorded
 * movement is what answers a retry. The submit additionally consumes its
 * named BUILD exactly once, so the two protections compose: a same-key retry
 * replays the movement, and a different-key resubmit of the same build is a
 * 409 instead of a second ledger row for one on-chain transaction.
 */
export async function createEarnWalletDeposit(
  c: ValidatedBodyContext<typeof earnWalletSubmitSchema>
) {
  const body: EarnWalletSubmitBody = c.req.valid("json");
  const requestId = requireWalletIdempotencyKey(c, "wallet deposits");
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  // Fail-closed audit admission (PRO-1866): no durable intent, no broadcast.
  const auditIntent = await beginEarnDepositAudit(
    c,
    {
      organizationId: auth.organizationId,
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    },
    {
      executionModel: "vault_direct",
      signer: "owner",
      transactionId: body.transactionId,
      requestId,
    }
  );

  let result: Awaited<ReturnType<typeof submitWalletDeposit>>;
  try {
    result = await submitWalletDeposit(c.env, {
      organizationId: auth.organizationId,
      projectId,
      transactionId: body.transactionId,
      signedTransaction: body.signedTransaction,
      requestId,
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    });
  } catch (error) {
    // A 4xx is a definitive pre-broadcast refusal (verification, build
    // consumption, recording): close the intent instead of paging
    // verification over it. Anything else stays UNRESOLVED (the submit can
    // 5xx after a successful send; see movement-audit.ts).
    await concludeEarnDepositAuditOnError(c, auditIntent, error);
    throw error;
  }

  await completeEarnDepositAudit(c, auditIntent, {
    resourceId: result.movement.id,
    metadata: {
      movementId: result.movement.id,
      ownerAddress: result.movement.owner_address,
      amount: result.movement.amount_requested,
      denomination: result.movement.denomination,
      signature: result.movement.signature,
      replayed: result.replayed,
    },
  });

  const response: EarnWalletDepositResponse = {
    deposit: toWalletMovementWire(
      result.movement,
      requirePositionTokenMint(result.position),
      result.replayed
    ),
  };
  return success(c, response);
}

/** Legacy submit: verify and record an already-built signed withdrawal. */
export async function createEarnWalletWithdrawal(
  c: ValidatedBodyContext<typeof earnWalletSubmitSchema>
) {
  const body: EarnWalletSubmitBody = c.req.valid("json");
  const requestId = requireWalletIdempotencyKey(c, "wallet withdrawals");
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const result = await submitWalletWithdrawal(c.env, {
    organizationId: auth.organizationId,
    projectId,
    transactionId: body.transactionId,
    signedTransaction: body.signedTransaction,
    requestId,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  });

  // Best-effort and post-effect (PRO-1866): a fail-closed audit write would
  // be a new way for the exit submit to 5xx (ADR 0002). A replay only
  // backfills an audit row the crashed original never wrote.
  await recordEarnWithdrawalAudit(
    c,
    {
      organizationId: auth.organizationId,
      userId: result.movement.created_by,
      apiKeyId: result.movement.initiated_by_key_id,
    },
    result.movement.id,
    {
      executionModel: "vault_direct",
      signer: "owner",
      transactionId: body.transactionId,
      ownerAddress: result.movement.owner_address,
      amount: result.movement.amount_requested,
      denomination: result.movement.denomination,
      signature: result.movement.signature,
      requestId,
    },
    { replayed: result.replayed }
  );

  const response: EarnWalletWithdrawalResponse = {
    withdrawal: toWalletMovementWire(
      result.movement,
      requirePositionTokenMint(result.position),
      result.replayed
    ),
  };
  return success(c, response);
}

function requireWalletIdempotencyKey(c: AppContext, noun: string): string {
  const requestId = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  if (requestId === null) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for ${noun}`);
  }
  return requestId;
}

/** One wallet holding with its owner and instrument columns proven present. */
export interface WalletHolding {
  id: string;
  provider: string;
  vaultAddress: string;
  label: string;
  ownerAddress: string;
  tokenMint: string;
  shareMint: string;
  shareAtaRentFunder: string | null;
  costBasisKnown?: boolean;
  createdAt: string;
  closedAt: string | null;
  /** Snapshot boundary for the read-path close-out; see closeEmptyHydratedPositions. */
  updatedAt: string;
}

/**
 * Narrow a position row to the wallet shape, or null. Everything that makes
 * this row NOT this caller's wallet holding answers identically: a custody
 * position (owner null), a custodial program, a sibling project's row, and a
 * genuinely missing id are all the same 404 upstream.
 */
function toWalletHolding(row: EarnPositionRow | null, projectId: string): WalletHolding | null {
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
    costBasisKnown: row.cost_basis_known !== false,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

function requireWalletHolding(row: EarnPositionRow, projectId: string): WalletHolding {
  const holding = toWalletHolding(row, projectId);
  if (!holding) {
    throw internalError(`Earn wallet position ${row.id} has an invalid claim shape`);
  }
  return holding;
}

function toWalletPositionWire(
  holding: WalletHolding,
  hydrated: HydratedVaultPositionValue | undefined
): EarnWalletPosition {
  return {
    id: holding.id,
    ownerAddress: holding.ownerAddress,
    provider: holding.provider,
    providerReference: holding.vaultAddress,
    label: holding.label,
    tokenMint: holding.tokenMint,
    shareMint: holding.shareMint,
    createdAt: holding.createdAt,
    closedAt: holding.closedAt,
    shares: hydrated?.shares,
    withdrawableShares: hydrated?.withdrawableShares,
    unlockTimestamp: hydrated?.unlockTimestamp,
    tokenValue: hydrated?.tokenValue,
    parIntermediate: hydrated?.parIntermediate,
  };
}

function toHydratableHolding(holding: WalletHolding) {
  return {
    id: holding.id,
    provider: holding.provider,
    providerReference: holding.vaultAddress,
    ownerAddress: holding.ownerAddress,
    tokenMint: holding.tokenMint,
    shareMint: holding.shareMint,
  };
}

interface MutableTokenTotal {
  tokenMint: string;
  owners: Set<string>;
  values: string[];
  positionCount: number;
  unavailablePositionCount: number;
}

interface MutableStrategyTotal {
  provider: string;
  providerReference: string;
  label: string;
  owners: Set<string>;
  positions?: EarnWalletPosition[];
  positionCount: number;
  tokens: Map<string, MutableTokenTotal>;
}

export function summarizeWalletPositions(
  holdings: readonly WalletHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  options: { includeOwnerAddresses: boolean; includePositions: boolean } = {
    includeOwnerAddresses: false,
    includePositions: false,
  }
): EarnWalletPositionSummary {
  const owners = new Set<string>();
  const strategies = new Map<string, MutableStrategyTotal>();
  const tokens = new Map<string, MutableTokenTotal>();
  let unavailablePositionCount = 0;
  let positionCount = 0;

  for (const holding of holdings) {
    const hydrated = live.get(holding.id);
    // A holding the live read proves empty holds nothing to count: its first
    // deposit has not landed, or it exited while a movement keeps the close-out
    // waiting. An unreadable holding still counts, as unavailable, never as zero.
    if (hydrated !== undefined && isEarnVaultHoldingEmpty(hydrated)) continue;
    positionCount += 1;
    owners.add(holding.ownerAddress);
    const value = hydratedHoldingTokenValue(hydrated);
    if (value === undefined) unavailablePositionCount += 1;

    const strategyKey = JSON.stringify([holding.provider, holding.vaultAddress]);
    let strategy = strategies.get(strategyKey);
    if (!strategy) {
      // Rows are collected newest first, so the first claim intentionally owns
      // the display label when old deposits for one vault used different copy.
      strategy = {
        provider: holding.provider,
        providerReference: holding.vaultAddress,
        label: holding.label,
        owners: new Set(),
        ...(options.includePositions ? { positions: [] } : {}),
        positionCount: 0,
        tokens: new Map(),
      };
      strategies.set(strategyKey, strategy);
    }
    strategy.owners.add(holding.ownerAddress);
    strategy.positions?.push(toWalletPositionWire(holding, hydrated));
    strategy.positionCount += 1;
    addToTokenTotal(strategy.tokens, holding, value);
    addToTokenTotal(tokens, holding, value);
  }

  return {
    walletCount: owners.size,
    positionCount,
    unavailablePositionCount,
    totalsByStrategy: [...strategies.values()]
      .map((strategy) => ({
        provider: strategy.provider,
        providerReference: strategy.providerReference,
        label: strategy.label,
        // The address list is the PII-bearing half of this read (EARN-028):
        // omitted by default and only present on an explicit opt-in. Omitted,
        // not emptied, so a consumer cannot mistake "not requested" for "no
        // owners".
        ...(options.includeOwnerAddresses
          ? { ownerAddresses: [...strategy.owners].sort(compareWireStrings) }
          : {}),
        ...(strategy.positions
          ? {
              positions: strategy.positions.sort(
                (left, right) =>
                  compareWireStrings(left.ownerAddress, right.ownerAddress) ||
                  compareWireStrings(left.id, right.id)
              ),
            }
          : {}),
        walletCount: strategy.owners.size,
        positionCount: strategy.positionCount,
        totalsByToken: [...strategy.tokens.values()].map(finalizeTokenTotal).sort(tokenTotalOrder),
      }))
      .sort(
        (left, right) =>
          compareWireStrings(left.label, right.label) ||
          compareWireStrings(left.provider, right.provider) ||
          compareWireStrings(left.providerReference, right.providerReference)
      ),
    totalsByToken: [...tokens.values()].map(finalizeTokenTotal).sort(tokenTotalOrder),
  };
}

function addToTokenTotal(
  totals: Map<string, MutableTokenTotal>,
  holding: WalletHolding,
  tokenValue: string | undefined
) {
  let total = totals.get(holding.tokenMint);
  if (!total) {
    total = {
      tokenMint: holding.tokenMint,
      owners: new Set(),
      values: [],
      positionCount: 0,
      unavailablePositionCount: 0,
    };
    totals.set(holding.tokenMint, total);
  }
  total.owners.add(holding.ownerAddress);
  total.positionCount += 1;
  if (tokenValue === undefined) total.unavailablePositionCount += 1;
  else total.values.push(tokenValue);
}

function finalizeTokenTotal(total: MutableTokenTotal): EarnWalletTokenTotal {
  return {
    tokenMint: total.tokenMint,
    walletCount: total.owners.size,
    positionCount: total.positionCount,
    unavailablePositionCount: total.unavailablePositionCount,
    ...(total.unavailablePositionCount === 0
      ? { tokenValue: sumDecimalAmounts(total.values) }
      : {}),
  };
}

function tokenTotalOrder(left: EarnWalletTokenTotal, right: EarnWalletTokenTotal) {
  return compareWireStrings(left.tokenMint, right.tokenMint);
}

function compareWireStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toWalletTransactionWire(built: WalletBuiltTransaction) {
  return {
    transactionId: built.id,
    transaction: built.unsigned_transaction,
    lastValidBlockHeight: built.last_valid_block_height,
    sponsored: false,
    ownerAddress: built.owner_address,
    // Echoed so the co-signing side can be driven from the response alone:
    // present means this transaction requires the fee payer's signature too.
    ...(built.fee_payer === null ? {} : { feePayer: built.fee_payer }),
    provider: built.provider,
    providerReference: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
  };
}

/**
 * Movement to wire, ledger vocabulary — with one translation: a provider-order
 * row the ledger holds at `finalized` (durable chain-leg evidence) reads as
 * `confirmed` with no `settledAt`, because the public contract defines
 * `finalized` as terminal settlement and the provider has not reported
 * completion yet. See `movementStatusOnWire`. `replayed` is a POST-only fact —
 * the reads leave it absent, because a stored row cannot say how it was asked
 * for.
 *
 * `amount`/`denomination` stay the on-chain quantity (shares on a withdrawal);
 * `tokenAmount`/`tokenMint` are the deposit-token view a feed renders: the
 * deposit amount, or the payout observed at settlement (0103), null until then.
 */
function toWalletMovementWire(
  movement: EarnMovementRow,
  tokenMint: string,
  replayed?: boolean
): EarnWalletMovement {
  if (!movement.vault_address || !movement.signature || !movement.owner_address) {
    throw internalError(`Earn wallet movement ${movement.id} is missing execution details`);
  }
  const { status, settledAt } = movementStatusOnWire(movement);
  return {
    settlementOutcome: providerSettlementFromData(movement.provider_data)?.outcome,
    movementId: movement.id,
    positionId: movement.position_id,
    provider: movement.provider,
    providerReference: movement.vault_address,
    direction: movement.direction,
    status: status as EarnVaultDirectMovementStatus,
    settlement:
      movement.direction === "deposit"
        ? earnProviderDepositSettlement(movement.provider)
        : earnProviderWithdrawalSettlement(movement.provider),
    signature: movement.signature,
    ownerAddress: movement.owner_address,
    amount: movement.amount_requested,
    denomination: movement.denomination,
    tokenMint,
    tokenAmount:
      movement.direction === "deposit" && movement.provider !== "kamino"
        ? (movement.token_amount_settled ?? movement.amount_requested)
        : movement.token_amount_settled,
    failureReason: movement.failure_reason,
    createdAt: movement.created_at,
    confirmedAt: movement.confirmed_at,
    settledAt,
    ...(replayed === undefined ? {} : { replayed }),
  };
}
