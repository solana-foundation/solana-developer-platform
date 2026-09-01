import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import { subtractDecimalAmounts, sumDecimalAmounts } from "@sdp/payments/decimal";
import type {
  EarnExternalWalletDepositResponse,
  EarnExternalWalletDepositTransactionResponse,
  EarnExternalWalletEarnedUnavailableReason,
  EarnExternalWalletEarnings,
  EarnExternalWalletEarningsResponse,
  EarnExternalWalletMovement,
  EarnExternalWalletMovementResponse,
  EarnExternalWalletMovementsPage,
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummary,
  EarnExternalWalletPositionSummaryResponse,
  EarnExternalWalletPositionsPage,
  EarnExternalWalletTokenTotal,
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
import { encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import {
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
} from "@/services/earn/vault-external-wallet.service";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  type earnExternalWalletDepositTransactionSchema,
  earnExternalWalletEarningsParamsSchema,
  earnExternalWalletEarningsQuerySchema,
  earnExternalWalletMovementParamsSchema,
  earnExternalWalletMovementsQuerySchema,
  earnExternalWalletPositionParamsSchema,
  earnExternalWalletPositionSummaryQuerySchema,
  earnExternalWalletPositionsQuerySchema,
  type earnExternalWalletSubmitSchema,
  type earnExternalWalletWithdrawalTransactionSchema,
} from "../schemas";
import { assertStrategyDepositable } from "./admission";
import { decodeMovementCursor } from "./movements";
import { parseParams, parseQuery } from "./shared";
import {
  decodeVaultPositionCursor,
  encodeVaultPositionCursor,
  type VaultPositionCursor,
} from "./vault-position-cursor";
import { type HydratedVaultPositionValue, hydrateVaultPositions } from "./vault-position-hydration";

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

const EXTERNAL_POSITION_PAGE_SIZE = 100;

/**
 * GET /v1/earn/external-wallet/positions/summary: complete live portfolio for
 * one partner project, grouped by strategy and by token.
 *
 * The claim table is keyset-paged to the end before any total is returned. A
 * repeated or non-advancing cursor fails the request instead of serving a
 * plausible-looking partial total.
 */
export async function getEarnExternalWalletPositionSummary(c: AppContext) {
  parseQuery(c, earnExternalWalletPositionSummaryQuerySchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const rows = await collectAllExternalWalletPositionRows((before) =>
    repo.listExternalWalletPositions({
      organizationId: auth.organizationId,
      projectId,
      environment,
      limit: EXTERNAL_POSITION_PAGE_SIZE,
      before,
    })
  );
  const holdings = rows.map((row) => requireExternalWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, environment, holdings.map(toHydratableHolding));
  const summary = summarizeExternalWalletPositions(holdings, live);
  if (summary.unavailablePositionCount > 0) {
    getLogger().warn(
      {
        event: "sdp_api_earn_external_wallet_position_summary_unavailable",
        organization_id: auth.organizationId,
        project_id: projectId,
        environment,
        position_count: summary.positionCount,
        unavailable_position_count: summary.unavailablePositionCount,
      },
      "external-wallet position summary: live values unavailable"
    );
  }
  const response: EarnExternalWalletPositionSummaryResponse = {
    summary,
  };
  return success(c, response);
}

/** GET /v1/earn/external-wallet/positions/:ownerAddress: one end user's holdings. */
export async function listEarnExternalWalletPositions(c: AppContext) {
  const { ownerAddress } = parseParams(c, earnExternalWalletPositionParamsSchema);
  const query = parseQuery(c, earnExternalWalletPositionsQuerySchema);
  const before = query.before ? decodeVaultPositionCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid external-wallet position pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  // Existence and ownership intentionally collapse to one 404. This separate
  // scoped check keeps a valid wallet answerable on an empty later page.
  const owned = await repo.hasExternalWalletPositionOwner({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress,
  });
  if (!owned) throw notFound("Earn external wallet");

  const page = await repo.listExternalWalletPositions({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress,
    limit: query.limit,
    before,
  });
  const holdings = page.rows.map((row) => requireExternalWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, environment, holdings.map(toHydratableHolding));
  const last = holdings.at(-1);
  const response: EarnExternalWalletPositionsPage = {
    ownerAddress,
    positions: holdings.map((holding) =>
      toExternalWalletPositionWire(holding, live.get(holding.id))
    ),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeVaultPositionCursor(last.createdAt, last.id) : null,
  };
  return success(c, response);
}

export async function collectAllExternalWalletPositionRows(
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
      throw internalError("External-wallet position pagination ended before completion");
    }
    const next = { createdAt: last.created_at, id: last.id };
    const key = JSON.stringify(next);
    if ((before && !cursorStrictlyPrecedes(next, before)) || seenBounds.has(key)) {
      throw internalError("External-wallet position pagination did not advance");
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
 * GET /v1/earn/external-wallet/movements: one end user's activity, newest
 * first, in the ledger's own vocabulary (PRO-1772).
 *
 * The read the cross-provider feed structurally cannot serve: its vault arm
 * requires a custody-wallet match and an owner-signed row has none. Like every
 * movement read this takes NO provider gate (ADR 0002 — it reports on money
 * that already moved) and, like the position reads, no `wallets:read`: these
 * are end-user wallets SDP does not custody, so wallet bindings have nothing
 * to say about them.
 *
 * The owner is a REQUIRED query filter, not a path segment, so the collection
 * keeps its `:movementId` detail route unambiguous. An owner this exact
 * project has never claimed a position for answers 404 — the same
 * existence-and-ownership collapse the positions read performs — so a partner
 * cannot distinguish "not yours" from "never seen" and an owner with only
 * in-flight history still answers an honest empty page.
 */
export async function listEarnExternalWalletMovements(c: AppContext) {
  const query = parseQuery(c, earnExternalWalletMovementsQuerySchema);
  const before = query.before ? decodeMovementCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid external-wallet movement pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const owned = await repo.hasExternalWalletPositionOwner({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress: query.ownerAddress,
  });
  if (!owned) throw notFound("Earn external wallet");

  const page = await repo.listExternalWalletMovements({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress: query.ownerAddress,
    direction: query.direction,
    status: query.status,
    limit: query.limit,
    before,
  });
  const last = page.rows.at(-1);
  const response: EarnExternalWalletMovementsPage = {
    ownerAddress: query.ownerAddress,
    movements: page.rows.map((row) => toExternalWalletMovementWire(row)),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
  };
  return success(c, response);
}

/**
 * GET /v1/earn/external-wallet/movements/:movementId: poll one movement to a
 * terminal state.
 *
 * This is what makes the submit's record-before-broadcast answerable on this
 * surface: the partner holds a movement id for a transaction whose fate it
 * never learned, and the reconciliation sweep settles it. Scoping answers 404
 * across the board — organization, EXACT project, environment, and the
 * external-wallet shape itself (a custody movement guessed by id is
 * indistinguishable from a missing row).
 */
export async function getEarnExternalWalletMovement(c: AppContext) {
  const { movementId } = parseParams(c, earnExternalWalletMovementParamsSchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const row = await createPostgresEarnMovementsRepository(getDb(c.env)).getExternalWalletMovement({
    organizationId: auth.organizationId,
    projectId,
    environment,
    movementId,
  });
  if (!row) throw notFound("Earn external wallet movement");

  const response: EarnExternalWalletMovementResponse = {
    movement: toExternalWalletMovementWire(row),
  };
  return success(c, response);
}

/**
 * GET /v1/earn/external-wallet/earnings/:ownerAddress: balance and total
 * earned for one end user, grouped by deposit token (PRO-1772).
 *
 * `earned` is live current value minus finalized SDP deposits — both facts,
 * one from the chain and one from the ledger — and it is stated only when it
 * is exact. Three things make it unstatable, each reported by name and none
 * of them ever coerced to zero:
 *
 * - a position's live value failed to hydrate (`live_value_unavailable`);
 * - a movement is still settling, so the chain and the ledger describe
 *   different moments (`movements_pending` — the reconciler drives every row
 *   terminal within about ninety seconds, so this is a short window, not a
 *   state);
 * - the wallet has a finalized withdrawal (`withdrawals_not_valued`): the
 *   ledger records exits in SHARES (migration 0070 pins `payout_token` NULL
 *   for vault rows), so no exact token-denominated earned figure exists once
 *   money has gone out.
 *
 * The ADR 0002 caveat applies at full strength: live hydration reads the
 * owner's WHOLE vault balance, so shares acquired outside SDP inflate
 * `currentValue` and therefore `earned`. That is the honest non-custodial
 * answer, documented rather than corrected — the chain cannot attribute
 * fungible shares to SDP movements.
 */
export async function getEarnExternalWalletEarnings(c: AppContext) {
  const { ownerAddress } = parseParams(c, earnExternalWalletEarningsParamsSchema);
  parseQuery(c, earnExternalWalletEarningsQuerySchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  const owned = await repo.hasExternalWalletPositionOwner({
    organizationId: auth.organizationId,
    projectId,
    environment,
    ownerAddress,
  });
  if (!owned) throw notFound("Earn external wallet");

  const scope = { organizationId: auth.organizationId, projectId, environment };
  const [rows, movementTotals] = await Promise.all([
    collectAllExternalWalletPositionRows((before) =>
      repo.listExternalWalletPositions({
        ...scope,
        ownerAddress,
        limit: EXTERNAL_POSITION_PAGE_SIZE,
        before,
      })
    ),
    repo.aggregateExternalWalletMovements({ ...scope, ownerAddress }),
  ]);
  const holdings = rows.map((row) => requireExternalWalletHolding(row, projectId));
  const live = await hydrateVaultPositions(c, environment, holdings.map(toHydratableHolding));

  const response: EarnExternalWalletEarningsResponse = {
    earnings: summarizeExternalWalletEarnings(ownerAddress, holdings, live, movementTotals),
  };
  return success(c, response);
}

interface MutableTokenEarnings {
  tokenMint: string;
  positionCount: number;
  unavailablePositionCount: number;
  values: string[];
  deposits: string[];
  earnedUnavailableReason?: EarnExternalWalletEarnedUnavailableReason;
}

/** Higher wins when several positions leave a token's earned unstatable. */
const EARNED_UNAVAILABLE_PRIORITY: Record<EarnExternalWalletEarnedUnavailableReason, number> = {
  live_value_unavailable: 3,
  movements_pending: 2,
  withdrawals_not_valued: 1,
};

function summarizeExternalWalletEarnings(
  ownerAddress: string,
  holdings: readonly ExternalWalletHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  movementTotals: ReadonlyMap<
    string,
    { finalizedDeposits: string; finalizedWithdrawalCount: number; unsettledMovementCount: number }
  >
): EarnExternalWalletEarnings {
  const tokens = new Map<string, MutableTokenEarnings>();
  let unavailablePositionCount = 0;

  for (const holding of holdings) {
    const value = live.get(holding.id)?.tokenValue;
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
      };
      tokens.set(holding.tokenMint, token);
    }
    token.positionCount += 1;
    if (value === undefined) token.unavailablePositionCount += 1;
    else token.values.push(value);
    if (totals) token.deposits.push(totals.finalizedDeposits);

    const reason = earnedUnavailableReason(value, totals);
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
        const currentValue =
          token.unavailablePositionCount === 0 ? sumDecimalAmounts(token.values) : undefined;
        return {
          tokenMint: token.tokenMint,
          positionCount: token.positionCount,
          unavailablePositionCount: token.unavailablePositionCount,
          ...(currentValue === undefined ? {} : { currentValue }),
          totalDeposited,
          // Σ(live_i − deposited_i) = Σlive − Σdeposited, so the token-level
          // difference IS the per-position sum — computed once, and only when
          // every contributing position can state it.
          ...(token.earnedUnavailableReason || currentValue === undefined
            ? { earnedUnavailableReason: token.earnedUnavailableReason ?? "live_value_unavailable" }
            : { earned: subtractDecimalAmounts(currentValue, totalDeposited) }),
        };
      })
      .sort((left, right) => compareWireStrings(left.tokenMint, right.tokenMint)),
  };
}

function earnedUnavailableReason(
  liveTokenValue: string | undefined,
  totals:
    | {
        finalizedDeposits: string;
        finalizedWithdrawalCount: number;
        unsettledMovementCount: number;
      }
    | undefined
): EarnExternalWalletEarnedUnavailableReason | null {
  if (liveTokenValue === undefined) return "live_value_unavailable";
  if (totals && totals.unsettledMovementCount > 0) return "movements_pending";
  if (totals && totals.finalizedWithdrawalCount > 0) return "withdrawals_not_valued";
  return null;
}

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
    deposit: toExternalWalletMovementWire(result.movement, result.replayed),
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
    withdrawal: toExternalWalletMovementWire(result.movement, result.replayed),
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
  createdAt: string;
  closedAt: string | null;
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
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function requireExternalWalletHolding(
  row: EarnPositionRow,
  projectId: string
): ExternalWalletHolding {
  const holding = toExternalWalletHolding(row, projectId);
  if (!holding) {
    throw internalError(`Earn external-wallet position ${row.id} has an invalid claim shape`);
  }
  return holding;
}

function toExternalWalletPositionWire(
  holding: ExternalWalletHolding,
  hydrated: HydratedVaultPositionValue | undefined
): EarnExternalWalletPosition {
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
    tokenValue: hydrated?.tokenValue,
  };
}

function toHydratableHolding(holding: ExternalWalletHolding) {
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
  positionCount: number;
  tokens: Map<string, MutableTokenTotal>;
}

function summarizeExternalWalletPositions(
  holdings: readonly ExternalWalletHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>
): EarnExternalWalletPositionSummary {
  const owners = new Set<string>();
  const strategies = new Map<string, MutableStrategyTotal>();
  const tokens = new Map<string, MutableTokenTotal>();
  let unavailablePositionCount = 0;

  for (const holding of holdings) {
    owners.add(holding.ownerAddress);
    const value = live.get(holding.id)?.tokenValue;
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
        positionCount: 0,
        tokens: new Map(),
      };
      strategies.set(strategyKey, strategy);
    }
    strategy.owners.add(holding.ownerAddress);
    strategy.positionCount += 1;
    addToTokenTotal(strategy.tokens, holding, value);
    addToTokenTotal(tokens, holding, value);
  }

  return {
    walletCount: owners.size,
    positionCount: holdings.length,
    unavailablePositionCount,
    totalsByStrategy: [...strategies.values()]
      .map((strategy) => ({
        provider: strategy.provider,
        providerReference: strategy.providerReference,
        label: strategy.label,
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
  holding: ExternalWalletHolding,
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

function finalizeTokenTotal(total: MutableTokenTotal): EarnExternalWalletTokenTotal {
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

function tokenTotalOrder(left: EarnExternalWalletTokenTotal, right: EarnExternalWalletTokenTotal) {
  return compareWireStrings(left.tokenMint, right.tokenMint);
}

function compareWireStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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
 * table to translate through. `replayed` is a POST-only fact — the reads
 * leave it absent, because a stored row cannot say how it was asked for.
 */
function toExternalWalletMovementWire(
  movement: EarnMovementRow,
  replayed?: boolean
): EarnExternalWalletMovement {
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
    ...(replayed === undefined ? {} : { replayed }),
  };
}
