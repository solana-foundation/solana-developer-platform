import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { notImplemented } from "@sdp/earn/errors";
import { compareDecimalAmounts } from "@sdp/payments/decimal";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { MovementOf } from "@sdp/types/movements";
import type { OperationIntent, OperationNextAction, OperationTerms } from "@sdp/types/operations";
import { earnDepositSlippagePolicy } from "@sdp/types/provider-access";
import { isAddress } from "@solana/kit";
import { getDb } from "@/db/client";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import {
  createPostgresEarnMovementsRepository,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import type {
  OperationScope,
  PreparedOperationAction,
} from "@/db/repositories/operations.repository";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import { getIdempotencyRecordKey, markIdempotencyCommitted } from "@/middleware/idempotency";
import { type AppContext, requireEarnStrategyForCaller } from "@/routes/earn/context";
import { assertVaultDepositAdmissible } from "@/routes/earn/handlers/admission";
import { resolveDepositSwapRequest } from "@/routes/earn/handlers/shared";
import { isEarnStrategyInExecutionShelf } from "@/routes/earn/strategy-catalogue";
import { resolveEarnCustodyWallet } from "@/routes/earn/wallet-scope";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { earnRuntime } from "@/services/earn/runtime";
import { strategyShareDecimals } from "@/services/earn/strategy-mint";
import {
  type PreparedStrategyWithdrawalChoice,
  prepareQueuedStrategyRecovery,
  prepareQueuedStrategyWithdrawal,
  prepareStrategyWithdrawalChoices,
  selectStrategyWithdrawalChoice,
} from "@/services/earn/strategy-queued-operations.service";
import { strategySharesForTokenAmount } from "@/services/earn/strategy-terms";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { resolveVaultSponsorship, type VaultFeeMode } from "@/services/earn/vault-sponsorship";
import {
  buildWalletDepositTransaction,
  buildWalletWithdrawalTransaction,
} from "@/services/earn/vault-wallet.service";
import { createOperationsService } from "@/services/operations.service";
import {
  DISCOVERED_EARN_POSITION_PREFIX,
  parseDiscoveredEarnPositionLocator,
} from "./discovered-position";
import { discoveredEarnPositionRow } from "./position-discovery";
import { prepareEarnDepositSchema, prepareEarnWithdrawalSchema } from "./schemas";

export interface EarnOperationActor extends OperationScope {
  auth: ApiKeyContext;
}

/** A resolved source carries no signing credentials or captured permissions. */
export interface EarnStrategySource {
  source: { walletId: string } | { ownerAddress: string };
  ownerAddress: string;
  wallet: CustodyRuntimeWalletProjection | null;
}

export interface AuthorizedEarnPreparation {
  actor: EarnOperationActor;
  intent: OperationIntent;
  source: EarnStrategySource;
  strategy: EarnStrategyRow | null;
  position: EarnPositionRow | null;
}

/** The same authenticated scope is used for reads, writes and operation recovery. */
export function earnOperationActor(c: AppContext): EarnOperationActor {
  const auth = getAuth(c);
  return {
    auth,
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    environment: currentClusterScope().environment,
  };
}

export async function resolveStrategySource(
  c: AppContext,
  actor: EarnOperationActor,
  source: { walletId: string } | { ownerAddress: string }
): Promise<EarnStrategySource> {
  if ("ownerAddress" in source) {
    if (!isAddress(source.ownerAddress)) throw badRequest("ownerAddress must be a Solana address");
    return { source, ownerAddress: source.ownerAddress, wallet: null };
  }
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets(
    actor
  );
  const wallet = resolveEarnCustodyWallet(wallets, source.walletId);
  assertCallerWalletInScope(actor.auth, wallet.id);
  return { source, ownerAddress: wallet.publicKey, wallet };
}

/** A named fee payer co-signs an owner's transaction; a custody wallet keeps its configured one. */
function assertFeePayer(feePayer: string | undefined, source: EarnStrategySource): void {
  if (feePayer === undefined) return;
  if (!isAddress(feePayer)) throw badRequest("feePayer must be a Solana address");
  if (source.wallet !== null) throw badRequest("A custody wallet uses its configured fee payer");
}

/** Resolve only ownership here; mutable strategy admission runs after idempotency. */
export async function authorizeEarnDeposit(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedEarnPreparation> {
  const body = prepareEarnDepositSchema.parse(input.body);
  const actor = earnOperationActor(c);
  const { strategy } = await requireEarnStrategyForCaller(c, body.strategyId);
  const source = await resolveStrategySource(c, actor, body.source);
  if (!isAddress(body.amount.mint)) throw badRequest("amount.mint must be a Solana mint address");
  assertFeePayer(body.feePayer, source);
  return { actor, intent: { kind: "earn.deposit", ...body }, source, strategy, position: null };
}

/** A position owns its strategy reference and source; withdrawals cannot swap either. */
export async function authorizeEarnWithdrawal(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedEarnPreparation> {
  const body = prepareEarnWithdrawalSchema.parse(input.body);
  const actor = earnOperationActor(c);
  let position: EarnPositionRow | null;
  let source: EarnStrategySource;
  let strategy: EarnStrategyRow | null = null;
  if (body.positionId.startsWith(DISCOVERED_EARN_POSITION_PREFIX)) {
    const selector = parseDiscoveredEarnPositionLocator(body.positionId);
    if (selector === null) throw notFound("Earn position");
    const resolved = await requireEarnStrategyForCaller(c, selector.strategyId);
    strategy = resolved.strategy;
    // Delisted strategies retain their authoritative instrument metadata. No
    // browse curation or deposit admission belongs on this exit path.
    if (strategy.host_cluster !== currentClusterScope().cluster) throw notFound("Earn position");
    source = await resolveStrategySource(c, actor, selector.source);
    position = discoveredEarnPositionRow(strategy, {
      source: selector.source,
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      environment: actor.environment,
    });
  } else {
    position = await createPostgresEarnMovementsRepository(getDb(c.env)).getPositionById({
      organizationId: actor.organizationId,
      environment: actor.environment,
      positionId: body.positionId,
    });
    if (position === null || position.kind !== "vault_direct") throw notFound("Earn position");
    if (position.custody_wallet_id !== null) {
      source = await resolveStrategySource(c, actor, { walletId: position.custody_wallet_id });
    } else {
      if (position.project_id !== actor.projectId || position.owner_address === null)
        throw notFound("Earn position");
      source = await resolveStrategySource(c, actor, { ownerAddress: position.owner_address });
    }
  }
  if (position === null) throw notFound("Earn position");
  assertFeePayer(body.feePayer, source);
  return { actor, intent: { kind: "earn.withdraw", ...body }, source, strategy, position };
}

function actionFor(
  source: EarnStrategySource,
  transaction: string,
  lastValidBlockHeight: string
): OperationNextAction {
  return source.wallet === null
    ? { type: "sign_transaction", transaction, lastValidBlockHeight, expiresAt: null }
    : { type: "submit" };
}

function emptyTerms(): OperationTerms {
  return { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] };
}

function preparationContext(actor: EarnOperationActor) {
  return {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    userId: actor.auth.userId,
    apiKeyId: actor.auth.apiKeyId,
  };
}

/** Applied when neither the caller nor the provider's policy names a deposit tolerance. */
const DEFAULT_DEPOSIT_SLIPPAGE_BPS = 50;

/**
 * A custody wallet signs through its provider, and SDP sponsors its fees where
 * policy allows. An owner address signs and pays for itself, so it adds nothing.
 */
async function custodySigning(
  c: AppContext,
  { actor, source }: AuthorizedEarnPreparation,
  movement: MovementOf<"earn">,
  sponsored = true
): Promise<{ custodyWalletId?: string; fee?: VaultFeeMode }> {
  if (source.wallet === null) return {};
  const custodyWalletId = source.wallet.id;
  if (!sponsored) return { custodyWalletId };
  const fee = await resolveVaultSponsorship(c.env, {
    movement,
    ...preparationContext(actor),
    walletId: custodyWalletId,
    deadline: createVaultDeadline(),
  });
  return { custodyWalletId, fee };
}

async function prepareDepositAction(
  c: AppContext,
  resolved: AuthorizedEarnPreparation
): Promise<PreparedOperationAction> {
  const { actor, intent, source } = resolved;
  if (intent.kind !== "earn.deposit") throw internalError("Expected a deposit intent");
  const context = preparationContext(actor);
  if (source.wallet !== null && !source.wallet.isRuntimeExecutionAllowed) {
    throw badRequest("The custody wallet is unavailable for new strategy deposits");
  }
  const strategy = resolved.strategy;
  if (strategy === null) throw internalError("Deposit strategy was not resolved");
  if (!isEarnStrategyInExecutionShelf(strategy)) {
    throw badRequest("This strategy is available for discovery only", {
      reason: "catalogue_only",
      strategyId: strategy.id,
    });
  }
  const provider = await assertVaultDepositAdmissible(c, strategy, intent.amount.value);
  const tokenMint = strategy.deposit_mints[0];
  if (tokenMint === undefined || strategy.share_mint === null)
    throw internalError("Strategy has no deposit asset identity");
  const swap = resolveDepositSwapRequest(
    { sourceTokenMint: intent.amount.mint, swapSlippageBps: intent.slippageBps },
    tokenMint
  );
  const policy = earnDepositSlippagePolicy(provider, actor.environment, strategy.host_cluster);
  const result = await buildWalletDepositTransaction(c.env, {
    ...context,
    provider,
    strategyId: strategy.id,
    providerReference: strategy.provider_reference,
    ownerAddress: source.ownerAddress,
    tokenMint,
    shareMint: strategy.share_mint,
    label: strategy.name,
    amount: intent.amount.value,
    slippageBps: intent.slippageBps ?? policy?.defaultToleranceBps ?? DEFAULT_DEPOSIT_SLIPPAGE_BPS,
    feePayer: intent.feePayer,
    // A swap-funded deposit always pays its own fees.
    ...(await custodySigning(c, resolved, "earn.deposit", swap === null)),
    ...(swap === null ? {} : { swap }),
  });
  const terms = emptyTerms();
  terms.inputAmount = intent.amount;
  terms.description = "Deposit into the strategy";
  if (result.quote !== undefined)
    terms.estimate = { mint: strategy.share_mint, value: result.quote.sharesOut };
  if (result.built.min_shares_out !== null)
    terms.minimum = { mint: strategy.share_mint, value: result.built.min_shares_out };
  return {
    nextAction: actionFor(
      source,
      result.built.unsigned_transaction,
      result.built.last_valid_block_height
    ),
    terms,
    buildRef: { kind: "earn.strategy_transaction", id: result.built.id },
  };
}

type WithdrawalPosition = EarnPositionRow & {
  strategy_reference: string;
  token_mint: string;
  share_mint: string;
};

function requireWithdrawalPosition(position: EarnPositionRow | null): WithdrawalPosition {
  const reference = position?.strategy_reference ?? position?.vault_address;
  if (
    position === null ||
    reference == null ||
    position.token_mint === null ||
    position.share_mint === null
  ) {
    throw internalError("Withdrawal position has no strategy asset identity");
  }
  return {
    ...position,
    strategy_reference: reference,
    token_mint: position.token_mint,
    share_mint: position.share_mint,
  };
}

/** What a withdrawal redeems: shares, or a held intermediate token. */
interface WithdrawalAmounts {
  shares?: string;
  intermediate?: { mint: string; value: string };
  discovered: boolean;
}

async function readWithdrawalHolding(
  c: AppContext,
  source: EarnStrategySource,
  position: WithdrawalPosition,
  allowMissing = false
) {
  const deadline = createVaultDeadline();
  const client = resolveEarnExecutionClient(c.env, position.provider, deadline);
  if (client === null || !supportsVaultDirect(client))
    throw notImplemented(position.provider, "strategy positions");
  const holdings = await client.readVaultPositions(earnRuntime(c.env), {
    owner: source.ownerAddress,
    providerReferences: [position.strategy_reference],
  });
  const holding = holdings.find(
    (row) =>
      row.providerReference === position.strategy_reference && row.owner === source.ownerAddress
  );
  if (holding === undefined) {
    if (allowMissing) return null;
    throw badRequest("No redeemable strategy position was found");
  }
  if (
    holding.tokenMint !== position.token_mint ||
    holding.shareMint !== position.share_mint ||
    holding.cluster !== currentClusterScope().cluster
  )
    throw badRequest("Live strategy asset identity changed");
  return holding;
}

type WithdrawalHolding = NonNullable<Awaited<ReturnType<typeof readWithdrawalHolding>>>;

function requireHeldIntermediate(
  holding: WithdrawalHolding,
  amount: { mint: string; value: string }
) {
  if (
    holding.parIntermediate === undefined ||
    holding.parIntermediate.mint !== amount.mint ||
    compareDecimalAmounts(holding.parIntermediate.withdrawableAmount, amount.value) < 0
  ) {
    throw badRequest("Held strategy intermediate is unavailable");
  }
}

async function sharesForTokenWithdrawal(
  holding: WithdrawalHolding,
  position: WithdrawalPosition,
  amount: { mint: string; value: string }
): Promise<string> {
  if (amount.mint !== position.token_mint)
    throw badRequest("Withdrawal amount must use the strategy's deposit token");
  if (holding.tokenValue === undefined || compareDecimalAmounts(holding.tokenValue, "0") <= 0)
    throw badRequest("Strategy token value is unavailable");
  return strategySharesForTokenAmount({
    shares: holding.shares,
    tokenValue: holding.tokenValue,
    tokenAmount: amount.value,
    shareDecimals: await strategyShareDecimals(position.share_mint),
  });
}

async function withdrawalAmounts(
  c: AppContext,
  resolved: AuthorizedEarnPreparation,
  position: WithdrawalPosition
): Promise<WithdrawalAmounts> {
  const { intent, source } = resolved;
  if (intent.kind !== "earn.withdraw") throw internalError("Expected a withdrawal intent");
  const { amount } = intent;
  const discovered = parseDiscoveredEarnPositionLocator(position.id) !== null;
  const amounts: WithdrawalAmounts = { discovered };
  if (amount.kind === "shares" && !discovered) {
    amounts.shares = amount.value;
  } else {
    const allowMissing = amount.kind === "all" && !discovered;
    const holding = await readWithdrawalHolding(c, source, position, allowMissing);
    // A tracked position may hold only escrow. Its recorded request and
    // live provider state, rather than a wallet balance, must prove recovery.
    if (holding === null) return amounts;
    if (amount.kind === "intermediate") {
      requireHeldIntermediate(holding, amount);
      amounts.intermediate = { mint: amount.mint, value: amount.value };
    } else if (amount.kind === "shares") {
      amounts.shares = amount.value;
    } else if (amount.kind === "token") {
      amounts.shares = await sharesForTokenWithdrawal(holding, position, amount);
    } else if (compareDecimalAmounts(holding.shares, "0") > 0) {
      amounts.shares = holding.shares;
    } else if (holding.parIntermediate !== undefined) {
      const { mint, withdrawableAmount } = holding.parIntermediate;
      amounts.intermediate = { mint, value: withdrawableAmount };
    }
  }
  if (amount.kind === "all") return amounts;
  const redeemable = amounts.shares ?? amounts.intermediate?.value;
  if (redeemable === undefined || compareDecimalAmounts(redeemable, "0") <= 0)
    throw badRequest("No redeemable strategy balance was found");
  return amounts;
}

function withdrawalAdapterPosition(position: WithdrawalPosition, source: EarnStrategySource) {
  return {
    id: position.id,
    provider: position.provider,
    vaultAddress: position.strategy_reference,
    tokenMint: position.token_mint,
    shareMint: position.share_mint,
    ownerAddress: source.ownerAddress,
    ...(source.wallet === null ? {} : { custodyWalletId: source.wallet.id }),
  };
}

async function prepareWithdrawalAction(
  c: AppContext,
  resolved: AuthorizedEarnPreparation,
  selectedOptionId?: string
): Promise<PreparedOperationAction> {
  const { intent, source } = resolved;
  if (intent.kind !== "earn.withdraw") throw internalError("Expected a withdrawal intent");
  const position = requireWithdrawalPosition(resolved.position);
  const amounts = await withdrawalAmounts(c, resolved, position);
  const { shares, intermediate } = amounts;
  const choices = await prepareStrategyWithdrawalChoices(c.env, {
    position: withdrawalAdapterPosition(position, source),
    shares,
    intermediateAmount: intermediate?.value,
    slippageBps: intent.slippageBps,
    ...(intent.amount.kind === "all" && !amounts.discovered
      ? { recovery: { actor: preparationContext(resolved.actor) } }
      : {}),
  });
  const terms = emptyTerms();
  terms.inputAmount =
    intermediate ?? (shares === undefined ? null : { mint: position.share_mint, value: shares });
  terms.options = choices.options;
  if (
    selectedOptionId === undefined &&
    (choices.choices.length > 1 || choices.choices[0]?.kind === "recovery")
  ) {
    terms.description = "Choose a withdrawal route before reviewing its transaction";
    return {
      nextAction: { type: "select_option" },
      terms,
      buildRef: { kind: "earn.withdrawal_options", id: `choices_${crypto.randomUUID()}` },
    };
  }
  const selected = selectStrategyWithdrawalChoice(choices, selectedOptionId);
  terms.description = selected.option.label;
  terms.estimate = selected.option.amount ?? null;
  terms.minimum = selected.option.minimum ?? null;
  // The selected route alone is now signable. Switching routes requires a new
  // prepared action, never a replacement of bytes under an existing signature.
  terms.options = [selected.option];
  return buildSelectedWithdrawalAction(c, resolved, position, amounts, selected, terms);
}

async function buildRecoveryAction(
  c: AppContext,
  resolved: AuthorizedEarnPreparation,
  position: WithdrawalPosition,
  selected: PreparedStrategyWithdrawalChoice,
  terms: OperationTerms
): Promise<PreparedOperationAction> {
  const { intent, source, actor } = resolved;
  if (
    selected.recovery === undefined ||
    intent.kind !== "earn.withdraw" ||
    intent.amount.kind !== "all" ||
    parseDiscoveredEarnPositionLocator(position.id) !== null
  )
    throw internalError("Expired escrow recovery has no authorized tracked request");
  const built = await prepareQueuedStrategyRecovery(c.env, {
    actor: preparationContext(actor),
    position: withdrawalAdapterPosition(position, source),
    request: selected.recovery,
    proof: selected.recoveryProof,
    feePayer: intent.feePayer,
    ...(await custodySigning(c, resolved, "earn.queued_withdraw_cancel")),
  });
  terms.inputAmount = { mint: selected.recovery.share_mint, value: selected.recovery.shares };
  return {
    nextAction: actionFor(source, built.unsignedTransaction, built.lastValidBlockHeight),
    terms,
    buildRef: { kind: "earn.queued_transaction", id: built.id },
  };
}

async function buildSelectedWithdrawalAction(
  c: AppContext,
  resolved: AuthorizedEarnPreparation,
  position: WithdrawalPosition,
  amounts: WithdrawalAmounts,
  selected: PreparedStrategyWithdrawalChoice,
  terms: OperationTerms
): Promise<PreparedOperationAction> {
  const { intent, source, actor } = resolved;
  if (intent.kind !== "earn.withdraw") throw internalError("Expected a withdrawal intent");
  const context = preparationContext(actor);
  const queuedPosition = withdrawalAdapterPosition(position, source);
  const { discovered, shares } = amounts;
  if (selected.kind === "recovery")
    return buildRecoveryAction(c, resolved, position, selected, terms);
  if (selected.kind === "queued") {
    if (selected.terms === undefined) throw internalError("Queued withdrawal terms are missing");
    const built = await prepareQueuedStrategyWithdrawal(c.env, {
      actor: context,
      position: queuedPosition,
      terms: selected.terms,
      feePayer: intent.feePayer,
      ...(await custodySigning(c, resolved, "earn.queued_withdraw_request")),
      ...(discovered && position.strategy_id != null
        ? { discoveredStrategyId: position.strategy_id }
        : {}),
    });
    if (built.build.quoted_assets !== null)
      terms.estimate = {
        mint: built.build.token_mint,
        value: built.build.quoted_assets,
      };
    return {
      nextAction: actionFor(source, built.unsignedTransaction, built.lastValidBlockHeight),
      terms,
      buildRef: { kind: "earn.queued_transaction", id: built.id },
    };
  }
  if (shares === undefined) throw internalError("Direct withdrawal has no share amount");
  const built = await buildWalletWithdrawalTransaction(c.env, {
    ...context,
    provider: position.provider,
    positionId: discovered ? null : position.id,
    strategyId: position.strategy_id ?? undefined,
    vaultAddress: position.strategy_reference,
    tokenMint: position.token_mint,
    shareMint: position.share_mint,
    ownerAddress: source.ownerAddress,
    label: position.label,
    shareAtaRentFunder: position.share_ata_rent_funder,
    shares,
    minAmountOut: terms.minimum?.value,
    feePayer: intent.feePayer,
    ...(await custodySigning(c, resolved, "earn.withdraw")),
  });
  return {
    nextAction: actionFor(source, built.unsigned_transaction, built.last_valid_block_height),
    terms,
    buildRef: { kind: "earn.strategy_transaction", id: built.id },
  };
}

/** Shared strategy planning; no signer, proposal or broadcast is resolved here. */
export async function prepareEarnStrategyAction(
  c: AppContext,
  resolved: AuthorizedEarnPreparation,
  selectedOptionId?: string
): Promise<PreparedOperationAction> {
  return resolved.intent.kind === "earn.deposit"
    ? prepareDepositAction(c, resolved)
    : prepareWithdrawalAction(c, resolved, selectedOptionId);
}

/** Both preparation routes return the same durable operation envelope. */
export async function prepareEarnOperation(c: AppContext) {
  const resolved = getAuthorized<AuthorizedEarnPreparation>(c);
  const requestKey = getIdempotencyRecordKey(c);
  if (requestKey === undefined)
    throw internalError("Earn preparation requires an idempotency claim");
  const service = createOperationsService(c.env);
  const prior = await service.replayPreparation(resolved.actor, {
    intent: resolved.intent,
    requestKey,
  });
  if (prior !== null) {
    markIdempotencyCommitted(c);
    return success(c, { operation: prior });
  }
  const prepared = await prepareEarnStrategyAction(c, resolved);
  const result = await service.prepare(resolved.actor, {
    intent: resolved.intent,
    source: resolved.source.source,
    requestKey,
    prepared,
  });
  markIdempotencyCommitted(c);
  return success(c, { operation: result.operation }, result.replayed ? 200 : 202);
}
