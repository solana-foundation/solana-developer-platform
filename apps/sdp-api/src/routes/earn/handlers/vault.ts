import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import { supportsVaultDepositQuote, supportsVaultWithdrawQuote } from "@sdp/earn/capabilities";
import { notImplemented } from "@sdp/earn/errors";
import type { EarnVaultDepositQuote, EarnVaultWithdrawQuote } from "@sdp/earn/types";
import type {
  EarnVaultDepositRecord,
  EarnVaultDepositResponse,
  EarnVaultDepositsPage,
  EarnVaultWithdrawal,
  EarnVaultWithdrawalResponse,
  EarnVaultWithdrawalsPage,
  SdpEnvironment,
} from "@sdp/types";
import {
  type EarnProviderId,
  earnDepositStyle,
  isVaultDirectDepositEnabled,
} from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  walletNotFound,
} from "@/lib/errors";
import {
  buildEarnVaultDepositFingerprint,
  buildEarnVaultWithdrawalFingerprint,
} from "@/lib/idempotency";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";
import {
  resolveVaultDirectClient,
  resolveVaultWithdrawClient,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
import { reconcileEarnVaultMovementReadThrough } from "@/services/earn/vault-movement-reconciliation.service";
import { refusedBuildMessage } from "@/services/earn/vault-refusals";
import { withdrawFromVault } from "@/services/earn/vault-withdraw.service";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { earnRuntime, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnVaultDepositParamsSchema,
  type earnVaultDepositPreviewSchema,
  type earnVaultDepositSchema,
  earnVaultDepositsQuerySchema,
  earnVaultPositionsQuerySchema,
  earnVaultWithdrawalParamsSchema,
  type earnVaultWithdrawalPreviewSchema,
  type earnVaultWithdrawalSchema,
  earnVaultWithdrawalsQuerySchema,
} from "../schemas";
import { assertStrategyDepositable, assertVaultDepositAdmissible } from "./admission";
import { parseParams, parseQuery, resolveDepositSwapRequest } from "./shared";
import { decodeVaultPositionCursor, encodeVaultPositionCursor } from "./vault-position-cursor";
import { hydrateVaultPositions } from "./vault-position-hydration";

/**
 * POST /v1/earn/vault-deposits — open or add to a non-custodial vault position,
 * funded from an SDP custody wallet and signed by SDP.
 *
 * A separate collection from `/programs` on purpose. A "program" is the
 * CUSTODIAL model: SDP provisions a provider wallet and the customer funds its
 * address later, so create and fund are two steps with an address in between.
 * A vault position has no address and no gap — the deposit IS the creation. One
 * endpoint that meant both would have to explain which half happened when the
 * chain rejected the transfer.
 */
/**
 * POST /v1/earn/vault-deposit-previews — what would this deposit mint right
 * now, from the provider's own live accounting. The dashboard derives its
 * `minSharesOut` floor from this quote, so the floor tracks the live share
 * rate instead of assuming one.
 *
 * A READ that takes the deposit's own money-in gates: the quote exists only
 * to open a NEW position, so surfacing, entitlement, admission and the
 * environment capability all apply exactly as they do on the deposit —
 * but no wallet, no policy gate and no idempotency key, because it moves
 * nothing and holds nothing.
 */
export async function createEarnVaultDepositPreview(
  c: ValidatedBodyContext<typeof earnVaultDepositPreviewSchema>
) {
  const body = c.req.valid("json");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);

  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Vault deposits are not available in production yet, so there is nothing to quote."
    );
  }

  const strategy = await getEarnRepository(c).getStrategyById(body.strategyId);
  if (!strategy || strategy.environment !== environment) {
    throw notFound("Earn strategy");
  }
  if (earnDepositStyle(strategy.provider) !== "vault_direct") {
    throw badRequest(
      `${strategy.provider} is a custodial provider; use POST /v1/earn/programs instead.`
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

  const deadline = createVaultDeadline();
  const client = resolveVaultDirectClient(c.env, provider, deadline);
  if (!client || !supportsVaultDepositQuote(client)) {
    throw notImplemented(provider, "vault deposit quoting");
  }

  let quote: EarnVaultDepositQuote;
  try {
    quote = await client.quoteVaultDeposit(earnRuntime(c), {
      providerReference: strategy.provider_reference,
      amount: body.amount,
    });
  } catch (error) {
    // A refused quote is the CALLER's, in the provider's own words — the SAME
    // code-shape mapping the deposit build applies (vault-refusals.ts), so the
    // next quote-capable provider inherits the 400 by using the vocabulary
    // instead of 500ing here on a caller-fixable amount. Everything else keeps
    // bubbling.
    const refusal = refusedBuildMessage(error);
    if (refusal !== null) throw badRequest(refusal);
    throw error;
  }

  return success(c, {
    strategyId: strategy.id,
    sharesOut: quote.sharesOut,
    shareDecimals: quote.shareDecimals,
    blockingIssues: quote.blockingIssues,
  });
}

export async function createEarnVaultDeposit(
  c: ValidatedBodyContext<typeof earnVaultDepositSchema>
) {
  const { body: parsedData, resolved } = getPolicyGateContext<
    EarnVaultDepositBody,
    EarnVaultDepositResolved
  >(c);
  const { strategy, wallet, auth, projectId, environment, provider, tokenMint, shareMint } =
    resolved;
  const requestId = resolved.requestId;
  if (requestId === null) {
    throw internalError("Vault deposit execution reached the handler without an idempotency key");
  }

  const result = await depositIntoVault(
    c.env,
    {
      organizationId: auth.organizationId,
      projectId,
      environment,
      provider,
      providerReference: strategy.provider_reference,
      wallet,
      tokenMint,
      shareMint,
      label: strategy.name,
      amount: parsedData.amount,
      requestId,
      minSharesOut: parsedData.minSharesOut,
      ...(resolved.swap === null ? {} : { swap: resolved.swap }),
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    },
    {
      runIntentTransaction: (mutation) => runApprovedWalletOperationEffectTransaction(c, mutation),
    }
  );

  if (result.replayed && approvedWalletOperationId(c)) {
    // Sequential replays do not pass through the insert transaction, so fence
    // the approved operation before returning their durable outcome. A legacy
    // unsigned row must fail closed instead of becoming a completed approval.
    await beginApprovedWalletOperationEffect(c);
    if (!result.movement.signature || result.movement.status === "failed") {
      throw conflict(
        "Approved vault deposit execution is incomplete and requires manual reconciliation"
      );
    }
  }

  return success(c, buildEarnVaultDepositResponse(result, strategy));
}

function buildEarnVaultDepositResponse(
  result: Awaited<ReturnType<typeof depositIntoVault>>,
  strategy: EarnStrategyRow
) {
  if (!result.movement.signature) {
    throw internalError(
      `Earn vault movement ${result.movement.id} was recorded without a signature`
    );
  }
  return {
    positionId: result.position.id,
    movementId: result.movement.id,
    // The ledger says `requested`; this contract's word for it is `pending`.
    status: toLegacyVaultDepositStatus(result.movement.status),
    signature: result.movement.signature,
    failureReason: result.movement.failure_reason,
    // Tells a retrying caller that its key was already used and NOTHING was
    // re-sent — distinct from a fresh success with the same shape.
    replayed: result.replayed,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      provider: strategy.provider,
      providerReference: strategy.provider_reference,
      hostCluster: strategy.host_cluster,
    },
  };
}

type EarnVaultDepositBody = z.output<typeof earnVaultDepositSchema>;

interface EarnVaultDepositResolved {
  strategy: EarnStrategyRow;
  wallet: CustodyRuntimeWalletProjection;
  auth: ApiKeyContext;
  projectId: string;
  environment: SdpEnvironment;
  provider: EarnProviderId;
  tokenMint: string;
  shareMint: string;
  requestId: string | null;
  idempotencyFingerprint: string;
  /** Swap-funded deposit: pay in `sourceTokenMint`, swap, then deposit. */
  swap: { sourceTokenMint: string; slippageBps: number } | null;
}

/**
 * Parse and resolve a vault deposit into its wallet-operation policy candidate.
 *
 * Everything the handler needs is resolved HERE, before the gate enforces, for
 * one reason: policy has to be decided from trusted, fully-resolved context —
 * the real custody wallet, the real amount, the real target — and it has to be
 * decided BEFORE `createOrgSigner` is reached. A gate that ran on the raw body
 * could be argued out of a denial by a caller who names a wallet it does not
 * hold; a gate that ran after resolution but inside the handler would already
 * have touched custody.
 */
export async function extractEarnVaultDepositPolicyCandidate(
  c: ValidatedBodyContext<typeof earnVaultDepositSchema>
): Promise<PolicyGateExtraction> {
  // The raw body (cached by `validateBody`'s read) is carried verbatim into
  // the policy envelope's rawPayload; the retired body `requestId` is rejected
  // by the schema itself, so it can never reach here.
  const rawBody: Record<string, unknown> = await c.req.json();
  const body = c.req.valid("json");

  const requestId = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  if (requestId === null && !isDryRunRequest(c)) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for vault deposits`);
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
    includeAllProviders: true,
  });

  // ENVIRONMENT CAPABILITY, before anything else and before any lookup.
  //
  // The exit path exists now (PRO-1702) and deliberately takes no such gate.
  // What keeps production deposits closed is PRO-1703: the Active tab does not
  // surface vault positions yet, so a mainnet position would sit outside the
  // customer's primary portfolio view. Entitlement cannot express this — it is
  // org-scoped, not environment-scoped — which is exactly why an entitled org
  // would otherwise reach mainnet early. The dashboard hides the affordance
  // from the same constant, so the button and the route agree by construction.
  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Vault deposits are not available in production yet: vault positions are not surfaced " +
        "on the Active tab, so a position opened here would sit outside the portfolio view."
    );
  }

  // SLIPPAGE FLOOR, required wherever real money moves.
  //
  // Kamino's pinned SDK selects the LEGACY deposit instruction when no
  // `minSharesOut` is given — there is no implicit floor, so a vault-state
  // change between signing and inclusion can mint materially fewer shares than
  // the caller reviewed. The dashboard now derives one from a live quote with
  // a displayed tolerance (`POST /vault-deposit-previews`) — an expiry is the
  // piece still missing — but API callers predate the floor, so requiring it
  // unconditionally today would still break working flows.
  //
  // This is scoped to production deliberately, and it is NOT dead code: the
  // environment gate above closes production for a different reason (no exit
  // path), and whoever lifts that gate must not silently also ship
  // unprotected deposits. This check is what makes the floor a prerequisite of
  // that change rather than something to remember.
  if (environment === "production" && body.minSharesOut === undefined) {
    throw badRequest(
      "minSharesOut is required for a production vault deposit: without a floor the pinned " +
        "Kamino SDK builds the legacy deposit instruction, which accepts any number of shares."
    );
  }

  // Resolve the strategy first: the caller names a catalogue row, never a raw
  // vault address. That keeps the deposit target inside what SDP catalogues and
  // means the admission gates the sync applied still bound this path.
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

  // MONEY-IN GATES, in the same order and with the same meaning as
  // `POST /programs` (see routes/earn/CLAUDE.md → "Gate asymmetry"). Opening a
  // vault position is a new commitment, so it takes all of:
  //
  //   shape       — a custodial provider reaching this route would silently
  //                 skip its wallet-provisioning model.
  //   surfacing   — "SDP does not offer this provider", which no per-org
  //                 override can lift, and which reads differently from
  //                 entitlement. Checked first so a caller is never pointed at
  //                 an activation door that does not exist.
  //   entitlement — the org's own override plus the environment's credentials.
  //   admission   — the catalogue row is `active` and its cluster is fundable
  //                 here. Shared with `POST /programs` rather than re-derived:
  //                 this path used to check neither, so a `paused` strategy —
  //                 an operator's deliberate stop during an exploit or depeg —
  //                 stayed fundable by id.
  //
  // The sequence lives in handlers/admission.ts so a future second money-in
  // caller shares it instead of re-deriving it. Money-OUT must never inherit
  // any of these (ADR 0002): un-offering a provider closes the door in, never
  // the door out.
  const provider = await assertVaultDepositAdmissible(c, strategy);

  // Swap funding, normalized before the gate so policy decides on what
  // actually leaves the wallet. A source equal to the vault's own token is a
  // no-op (null), and an unsupported mint is refused here, before any
  // custody-shaped work.
  const swap = resolveDepositSwapRequest(body, environment, tokenMint);

  // The wallet must be one SDP can sign for, and the binding must carry a WRITE
  // scope. `wallets:read` on a binding only proves the key may LOOK at the
  // wallet — a read-only-bound key was previously able to spend from it. Global
  // `wallets:read` is required at the router for the same reason payments does
  // it: for a key with NO bindings the per-wallet assertion is a no-op, so the
  // router permission is the only gate that key ever meets.
  // Resolve only the exposed custody row id. Provider wallet ids are unique
  // only within one custody configuration, and public keys may also repeat, so
  // neither is a safe identifier for this money-in route.
  const wallet = resolveEarnVaultCustodyWallet(wallets, body.custodyWalletId);
  assertBoundWalletIdentifierIsUnique(auth, wallets, wallet);
  assertApiKeyWalletAccess(auth, wallet.walletId, ["earn:write"]);

  const resolved: EarnVaultDepositResolved = {
    strategy,
    wallet,
    auth,
    projectId,
    environment,
    provider,
    tokenMint,
    shareMint,
    requestId,
    swap,
    idempotencyFingerprint: buildEarnVaultDepositFingerprint({
      environment,
      provider,
      providerReference: strategy.provider_reference,
      custodyWalletId: wallet.id,
      amount: body.amount,
      minSharesOut: body.minSharesOut ?? null,
      // Only when swap-funded, so every pre-existing fingerprint stays valid.
      ...(swap === null
        ? {}
        : {
            swapSourceTokenMint: swap.sourceTokenMint,
            swapSlippageBps: swap.slippageBps,
          }),
    }),
  };

  return {
    candidate: {
      organizationId: auth.organizationId,
      projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: auth.apiKeyId ?? null,
      actor: walletOperationActorFromAuth(auth),
      source: "earn_vault_deposit",
      // `program`, not `payment`: this is an interaction with an on-chain
      // program, and no funds leave the org — the shares come back to the same
      // custody wallet. Family rules are opt-in (a rule listing no families
      // matches everything), so wallet deny rules, amount limits and approval
      // requirements still apply; only a rule that explicitly enumerates
      // families would need `program` added to it.
      operationFamily: "program",
      operationType: "earn_vault_deposit",
      // What is actually MOVING OUT of the wallet: the deposit token from the
      // catalogue row ordinarily, or the swap's source token for a swap-funded
      // deposit — an asset-scoped rule ("never move USDT") must see the token
      // the wallet pays with, not the one the vault eventually receives.
      asset: swap === null ? tokenMint : swap.sourceTokenMint,
      amount: body.amount,
      // The vault account, which is emphatically NOT a payable address —
      // funds sent to it directly are destroyed. It is carried because a
      // destination-scoped rule still needs to name the thing being deposited
      // into, and it is the only stable identifier for that.
      destination: strategy.provider_reference,
      context: {
        provider,
        strategyId: strategy.id,
        strategyName: strategy.name,
        hostCluster: strategy.host_cluster,
        environment,
        depositStyle: "vault_direct",
        minSharesOut: body.minSharesOut ?? null,
        // The swap leg, stated for approvers: a swap-funded deposit spends
        // `asset` above and deposits `depositTokenMint` into the vault.
        swap:
          swap === null
            ? null
            : {
                sourceTokenMint: swap.sourceTokenMint,
                slippageBps: swap.slippageBps,
                depositTokenMint: tokenMint,
              },
      },
      providerExtensions: {},
    },
    legs: [],
    body,
    resolved,
    rawPayload: {
      ...rawBody,
      idempotencyFingerprint: resolved.idempotencyFingerprint,
    },
    idempotencyKey: requestId,
  };
}

/** Resolve both durable movement replays and pre-execution policy replays. */
export async function findEarnVaultDepositIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  // An approval executor must pass through policy resume and the handler's
  // effect fence, even when the domain movement was already recorded.
  if (approvedWalletOperationId(c)) return null;

  const resolved = extraction.resolved as EarnVaultDepositResolved;
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const movement = await repo.findVaultMovementByRequestId({
    organizationId: resolved.auth.organizationId,
    requestId: idempotencyKey,
  });
  if (movement) {
    // PROJECT boundary on the replay, not just on the reads. The lookup above is
    // keyed on `(organization_id, request_id)` — migration 0059's unique index —
    // so a key first used in a SIBLING project resolves that project's movement.
    // Returning it would both answer the wrong deposit and hand over its amount
    // and signature. Reachable because organization-level custody configs give
    // two projects the same `custody_wallets` row, so the rest of the request can
    // legitimately match.
    //
    // Answered as the fingerprint conflict it is: the key really has been used by
    // a different request. The caller chose the key, so learning that its own key
    // is taken within its own organization tells it nothing it did not supply.
    if (
      !isMovementInProject(movement, resolved.projectId) ||
      movement.idempotency_fingerprint !== resolved.idempotencyFingerprint
    ) {
      throw conflict("Idempotency key already used with different request payload");
    }
    if (movement.status === "failed") {
      throw conflict(
        movement.failure_reason ?? "The recorded vault deposit failed and cannot be replayed"
      );
    }
    const position = await repo.getPositionById({
      organizationId: resolved.auth.organizationId,
      environment: resolved.environment,
      positionId: movement.position_id,
    });
    if (!position) {
      throw internalError(`Replayed movement ${movement.id} references a missing position`);
    }
    return success(
      c,
      buildEarnVaultDepositResponse({ position, movement, replayed: true }, resolved.strategy)
    );
  }

  await throwOnPriorVaultPolicyOperation(c, {
    organizationId: resolved.auth.organizationId,
    projectId: resolved.projectId,
    idempotencyKey,
    idempotencyFingerprint: resolved.idempotencyFingerprint,
    operationNoun: "vault deposit",
  });
  return null;
}

/**
 * Pre-execution policy replays, shared by both vault money movers: a key that
 * already produced a wallet operation must answer with that operation's state
 * (still pending approval, executing, denied, canceled) rather than starting a
 * second one — and a key reused with a different payload is a conflict even
 * before any movement exists.
 */
async function throwOnPriorVaultPolicyOperation(
  c: AppContext,
  params: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    operationNoun: "vault deposit" | "vault withdrawal";
  }
): Promise<void> {
  const prior = await getDb(c.env)
    .prepare(
      `SELECT operation.id, operation.status, operation.raw_payload,
              evaluation.id AS policy_evaluation_id,
              evaluation.decision, evaluation.reason_code, evaluation.reason,
              evaluation.requires_approval, evaluation.approval_request_id
       FROM wallet_operations operation
       LEFT JOIN LATERAL (
         SELECT * FROM policy_evaluations
         WHERE wallet_operation_id = operation.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) evaluation ON TRUE
       WHERE operation.organization_id = ?
         AND operation.project_id = ?
         AND operation.idempotency_key = ?`
    )
    .bind(params.organizationId, params.projectId, params.idempotencyKey)
    .first<{
      id: string;
      status: string;
      raw_payload: Record<string, unknown>;
      policy_evaluation_id: string | null;
      decision: string | null;
      reason_code: string | null;
      reason: string | null;
      requires_approval: boolean | null;
      approval_request_id: string | null;
    }>();
  if (!prior) return;
  if (prior.raw_payload.idempotencyFingerprint !== params.idempotencyFingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }

  const details = {
    walletOperationId: prior.id,
    policyEvaluationId: prior.policy_evaluation_id,
    decision: prior.decision,
    reasonCode: prior.reason_code,
    reason: prior.reason,
    requiresApproval: prior.requires_approval,
    approvalRequestId: prior.approval_request_id,
  };
  if (prior.status === "pending_approval" || prior.status === "executing") {
    throw new AppError(
      "SIGNING_PENDING",
      prior.status === "pending_approval"
        ? "Wallet operation requires policy approval"
        : `Approved ${params.operationNoun} execution is still in progress`,
      details
    );
  }
  if (prior.decision === "deny" || prior.status === "canceled") {
    throw new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
  }
  throw conflict(`The prior ${params.operationNoun} policy operation has no replayable movement`);
}

function resolveEarnVaultCustodyWallet(
  wallets: readonly CustodyRuntimeWalletProjection[],
  custodyWalletId: string
): CustodyRuntimeWalletProjection {
  const exact = wallets.find((wallet) => wallet.id === custodyWalletId);
  if (exact) return exact;
  throw walletNotFound();
}

function assertBoundWalletIdentifierIsUnique(
  auth: EarnVaultDepositResolved["auth"],
  wallets: readonly CustodyRuntimeWalletProjection[],
  wallet: CustodyRuntimeWalletProjection
): void {
  const selectedScope =
    auth.authType === "api_key" &&
    (auth.walletBindings.length > 0 ||
      auth.signingWalletId !== null ||
      auth.signingWalletIds.length > 0);
  if (!selectedScope) return;

  if (wallets.filter((candidate) => candidate.walletId === wallet.walletId).length !== 1) {
    throw new AppError(
      "FORBIDDEN",
      "The selected API-key wallet binding is ambiguous across custody configurations"
    );
  }
}

/**
 * The custody wallets an earn READ may see, already narrowed to the caller's
 * API-key wallet bindings.
 *
 * Shared by every vault read so the binding rule cannot drift between them: a
 * selected-wallet key that may not read wallet B's position must not be able to
 * read wallet B's deposits either.
 *
 * The id spaces differ and that is the trap. `getAllowedApiKeyWalletIdsForPermissions`
 * returns PROVIDER wallet ids (`privy_…`), while `earn_positions.custody_wallet_id`
 * and `earn_movements.custody_wallet_id` are `custody_wallets` row ids
 * (`cwlt_…`). The projection carries both, so it is the translation table;
 * comparing the allow-list directly against a stored id matches nothing and
 * silently answers "you hold none of this", which is a filter that looks like
 * it works and hides money.
 *
 * A provider wallet id that maps to more than one scoped custody row is
 * dropped: the binding cannot say which row it meant, so it authorizes neither.
 */
export async function listReadableEarnVaultWallets(
  c: AppContext,
  auth: ApiKeyContext,
  projectId: string
): Promise<CustodyRuntimeWalletProjection[]> {
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
    includeAllProviders: true,
  });

  const allowedProviderWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["earn:read"]);
  if (allowedProviderWalletIds === null) return wallets;

  const allowed = new Set(allowedProviderWalletIds);
  const scopedProviderWalletCounts = new Map<string, number>();
  for (const wallet of wallets) {
    scopedProviderWalletCounts.set(
      wallet.walletId,
      (scopedProviderWalletCounts.get(wallet.walletId) ?? 0) + 1
    );
  }
  return wallets.filter(
    (wallet) =>
      allowed.has(wallet.walletId) && scopedProviderWalletCounts.get(wallet.walletId) === 1
  );
}

/**
 * PROJECT boundary for a recorded movement.
 *
 * Wallet scope alone does not close this. Custody configs may be
 * ORGANIZATION-level (`config.project_id IS NULL`), and `listWallets` hands
 * those to every project in the org — so a sibling project's deposit signed by a
 * shared org wallet passes the wallet check, and without this it would hand over
 * that deposit's amount, signature and failure reason.
 *
 * This is deliberately STRICTER than `GET /vault-positions`, which scopes by
 * wallet alone, and the asymmetry is the point: a POSITION is a holding the
 * organization owns and every project may legitimately see, while a MOVEMENT is
 * one project's individual transaction and exposes a specific amount and
 * signature that the position does not. It is the same tightening
 * `getEarnProgramWithdrawal` already made when it moved from an org-only check
 * to a per-program one.
 *
 * An EXACT match, with no null exception. `project_id` is nullable only because
 * of `ON DELETE SET NULL` (migration 0059) — the insert requires a real project
 * id — so a null means the owning project was DELETED. Treating that as
 * readable-by-anyone was a hole: it handed a deleted project's deposits to every
 * sibling project that shares an org-level wallet, which is exactly the leak
 * this guard exists to close. The row survives for forensics in the database;
 * it is simply no longer addressable through a project-scoped API, and there is
 * no caller who legitimately needs a deleted project's deposit. Nothing about
 * exit safety argues otherwise — the POSITION still holds the money and is
 * still readable by wallet scope.
 */
function isMovementInProject(movement: { project_id: string | null }, projectId: string): boolean {
  return movement.project_id === projectId;
}

/**
 * GET /v1/earn/vault-deposits/:movementId — one recorded deposit, so a caller
 * that signed something can find out whether it landed.
 *
 * SDP signs vault deposits and records them BEFORE broadcast, which means a
 * caller can hold a movement id for a transaction whose fate it never learned:
 * a `pending` row is "we could not establish that this reached the network",
 * not "this failed". The every-minute reconciliation sweep
 * (`services/jobs/reconcile-earn-vault-movements.ts`) drives every row to
 * `confirmed` or `failed`; this route is how anyone else finds out. Without it
 * the only honest thing a client could tell a customer about a signed deposit
 * was "check the explorer".
 *
 * NO provider gate, exactly like `GET /vault-positions` and for the same ADR
 * 0002 reason: this reports on money that has already left the customer's
 * wallet. Un-offering or un-entitling a provider closes the door in, and must
 * never take away the answer to "did my deposit land".
 *
 * THREE scoping rules, all of which answer 404 rather than 403 — a caller who
 * may not see a movement must not learn that it exists:
 *
 *   organization — enforced in the repository query itself. Movement ids are
 *                  UUID-suffixed rather than sequential, but this is the guard
 *                  that makes guessing one useless (BOLA), the same reasoning
 *                  as `getEarnProgramWithdrawal`.
 *   environment  — a sandbox-scoped key must not read a production movement.
 *                  The row carries its own environment, so this is a
 *                  comparison, not a second query.
 *   project      — see `isMovementInProject`. Wallet scope does NOT imply it,
 *                  because an organization-level custody config is handed to
 *                  every project in the org. An EXACT match: a null
 *                  `project_id` means the project was deleted, not that the row
 *                  is public.
 *   direction    — a withdrawal is not a deposit. The column is the only thing
 *                  separating the two on a shared table; the withdrawal reads
 *                  below apply the same rule pointed the other way, so each
 *                  surface serves exactly its own direction.
 */
export async function getEarnVaultDeposit(c: AppContext) {
  const { movementId } = parseParams(c, earnVaultDepositParamsSchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const movement = await repo.getMovementById({
    movementId,
    organizationId: auth.organizationId,
  });
  if (
    !movement ||
    movement.environment !== environment ||
    // The ledger holds both execution models, so "is this a vault deposit" is now
    // two columns rather than a table name. A custodial withdrawal reached by a
    // guessed id must 404 exactly like a wrong-organization row.
    movement.execution_model !== "vault_direct" ||
    movement.direction !== "deposit" ||
    !isMovementInProject(movement, projectId)
  ) {
    throw notFound("Earn vault deposit");
  }

  // Wallet-binding scope, applied to the movement's OWN custody wallet. The
  // deposit names the wallet that signed it, so a key bound elsewhere is asking
  // about someone else's transaction.
  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  if (!scopedWallets.some((wallet) => wallet.id === movement.custody_wallet_id)) {
    throw notFound("Earn vault deposit");
  }

  // The scope checks happen before the chain read so a guessed movement id
  // cannot use RPC timing to learn that another workspace's transaction exists.
  // The scheduled sweep remains the recovery path if this best-effort read fails.
  const currentMovement = await reconcileEarnVaultMovementReadThrough(c.env, movement);
  const response: EarnVaultDepositResponse = {
    deposit: toEarnVaultDepositRecord(currentMovement),
  };
  return success(c, response);
}

/**
 * The published vault-deposit vocabulary, which predates the unified ledger.
 *
 * Two values need translating and both are deliberate: `requested` is the ledger's
 * one word for "a signed transaction is durably recorded but is not known to be
 * on the wire", which this DTO calls `pending`; and `finalized` — irreversible
 * chain settlement — has no name here at all, because this vocabulary was written
 * when optimistic commitment was the end of the story.
 *
 * Mapping `finalized` down to `confirmed` therefore tells the existing client
 * exactly what it already understood, rather than sending it a status its own Zod
 * enum would reject. Delete this table, and the `?settled=` note in the
 * repository, when the DTO adopts the ledger vocabulary.
 */
const LEGACY_VAULT_DEPOSIT_STATUS = {
  requested: "pending",
  submitted: "submitted",
  confirmed: "confirmed",
  finalized: "confirmed",
  failed: "failed",
} as const satisfies Record<string, EarnVaultDepositRecord["status"]>;

function toLegacyVaultDepositStatus(status: string): EarnVaultDepositRecord["status"] {
  const mapped = LEGACY_VAULT_DEPOSIT_STATUS[status as keyof typeof LEGACY_VAULT_DEPOSIT_STATUS];
  if (!mapped) {
    throw internalError(`Earn vault movement carries the unmappable status ${status}`);
  }
  return mapped;
}

/**
 * Shared row -> wire mapping, so the list and the detail cannot drift.
 *
 * `vault_address` is what this DTO calls `providerReference`. The unified ledger
 * reserves `provider_reference` for the provider's id FOR THE MOVEMENT, which a
 * vault movement does not have — the vault is the INSTRUMENT, and 0059 having
 * used one column name for both meanings is exactly what made the two tables
 * unmergeable until it was unpicked.
 *
 * `amount` serves `amount_requested`. 0059 stored the caller's text and the
 * provider plan's canonical spelling in two columns and enforced them NUMERICALLY
 * EQUAL, so this is the same quantity; only the spelling can differ (`100` where
 * the padded form said `100.000000`).
 */
function toEarnVaultDepositRecord(movement: EarnMovementRow): EarnVaultDepositRecord {
  // Guaranteed by 0062's model-shape constraint for a vault_direct row; asserted
  // rather than coerced, because a blank instrument or signature on the wire
  // would be a silent lie about a real on-chain transaction.
  if (!movement.vault_address || !movement.signature) {
    throw internalError(
      `Earn vault movement ${movement.id} is missing its instrument or signature`
    );
  }
  return {
    movementId: movement.id,
    positionId: movement.position_id,
    provider: movement.provider,
    providerReference: movement.vault_address,
    status: toLegacyVaultDepositStatus(movement.status),
    signature: movement.signature,
    amount: movement.amount_requested,
    failureReason: movement.failure_reason,
    createdAt: movement.created_at,
    confirmedAt: movement.confirmed_at,
  };
}

/**
 * GET /v1/earn/vault-deposits — this workspace's recorded deposits, newest
 * first, so a client can re-derive what is still in flight.
 *
 * This is the DISCOVERY tier, and it exists because a signed deposit was
 * previously only findable by an id the browser held in memory: close the tab
 * and the outcome of a real on-chain transaction became unreachable. The
 * custodial side already solves this by re-deriving withdrawals from its
 * ledger; this is the same answer for vault deposits, and it is what lets the
 * dashboard stop keeping its own per-tab watch list.
 *
 * It also closes the APPROVAL-GATED hole. A policy hold returns an
 * `approvalRequestId` and NO `movementId`, because no movement exists until
 * someone approves — but the approval executor replays the caller's original
 * `Idempotency-Key`, so the movement it eventually creates carries it. Passing
 * `?requestId=` therefore finds a deposit that did not exist when it was
 * requested. The key is caller-chosen, short keys are legal, and it is even
 * published on chain in the deposit memo — so it is emphatically NOT treated as
 * a capability: this route re-applies every scoping rule the detail route
 * applies, and a guessed key can only surface a deposit the caller could
 * already read.
 *
 * Same gates as the detail read: no provider gate (ADR 0002), organization from
 * the query, then environment, direction, project and wallet-binding scope.
 */
export async function listEarnVaultDeposits(c: AppContext) {
  const query = parseQuery(c, earnVaultDepositsQuerySchema);
  const before = query.before ? decodeVaultMovementCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid vault deposit pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];
  if (custodyWalletIds.length === 0) {
    return success(c, { deposits: [], hasMore: false, nextCursor: null });
  }
  const scopedWalletIds = new Set(custodyWalletIds);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  // The single-key lookup deliberately does NOT page. It resolves at most one
  // row (0062's partial unique index on (organization_id, request_id) for vault
  // rows, carried over from 0059), and running it through the keyset query would
  // mean indexing for a filter that can never return two rows.
  if (query.requestId !== undefined) {
    const movement = await repo.findVaultMovementByRequestId({
      organizationId: auth.organizationId,
      requestId: query.requestId,
    });
    const visible =
      movement !== null &&
      movement.environment === environment &&
      movement.direction === "deposit" &&
      isMovementInProject(movement, projectId) &&
      movement.custody_wallet_id !== null &&
      scopedWalletIds.has(movement.custody_wallet_id);
    return success(c, {
      deposits: visible && movement ? [toEarnVaultDepositRecord(movement)] : [],
      hasMore: false,
      nextCursor: null,
    });
  }

  const { rows, hasMore } = await repo.listVaultMovements({
    organizationId: auth.organizationId,
    environment,
    projectId,
    custodyWalletIds,
    direction: "deposit",
    limit: query.limit,
    before,
    settled: query.settled,
  });

  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null;
  const response: EarnVaultDepositsPage = {
    deposits: rows.map(toEarnVaultDepositRecord),
    hasMore,
    nextCursor,
  };
  return success(c, response);
}

const vaultMovementCursorSchema = z.object({
  // `created_at` is ordered as canonical UTC text, so accepting offsets or a
  // different precision would make a syntactically valid cursor sort wrongly.
  createdAt: z.string().datetime({ precision: 3 }),
  // Shape and bound only, NOT a prefix. Movement ids are heterogeneous by design:
  // the unification preserved every legacy row's id, so the table holds
  // `earn_vault_movement_…` history beside `earn_movement_…` for anything minted
  // since. Pinning a prefix here rejected page two outright.
  //
  // Safe because a cursor is a pagination BOUND, not an access grant — it lands in
  // `(created_at, id) < (?, ?)` while organization, environment, project and wallet
  // scope are separate conditions, so a forged one can only reposition a caller
  // inside rows it could already read.
  id: z
    .string()
    .min(1)
    .max(128)
    .refine((id) => id === id.toLowerCase()),
});

function decodeVaultMovementCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeKeysetCursor(cursor);
  if (!decoded) return null;
  const parsed = vaultMovementCursorSchema.safeParse({ createdAt: decoded.value, id: decoded.id });
  return parsed.success ? parsed.data : null;
}

/**
 * One vault holding with its instrument columns proven present.
 *
 * `earn_positions` holds both custody models, so the vault-only columns are
 * nullable at the type level even though 0062's shape constraint makes them
 * NOT NULL for a `vault_direct` row. Narrowing once here keeps the hydration
 * below from either coercing a blank vault address into a chain read or
 * repeating the same assertion six times.
 */
interface VaultHolding {
  id: string;
  provider: string;
  vaultAddress: string;
  label: string;
  custodyWalletId: string;
  tokenMint: string;
  shareMint: string;
  createdAt: string;
  closedAt: string | null;
}

function toVaultHolding(row: EarnPositionRow): VaultHolding {
  if (!row.vault_address || !row.custody_wallet_id || !row.token_mint || !row.share_mint) {
    throw internalError(`Earn vault position ${row.id} is missing its instrument identity`);
  }
  return {
    id: row.id,
    provider: row.provider,
    vaultAddress: row.vault_address,
    label: row.label,
    custodyWalletId: row.custody_wallet_id,
    tokenMint: row.token_mint,
    shareMint: row.share_mint,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

/**
 * GET /v1/earn/vault-positions — the org's vault positions, HYDRATED LIVE.
 *
 * The DB rows are only the claim set (which wallet holds which vault). Shares
 * and value are read from chain on every request, never persisted: for a
 * non-custodial vault the chain IS the provider, and ADR 0002's rule is that
 * positions are provider truth read live.
 *
 * NO provider gate here. This is a READ of money the org already holds, and
 * ADR 0002's exit-safety asymmetry says un-offering or un-entitling a provider
 * must never hide a position — it closes the door in, never the door out. The
 * money-in route above takes both gates; this one deliberately takes neither.
 */
export async function listEarnVaultPositions(c: AppContext) {
  const query = parseQuery(c, earnVaultPositionsQuerySchema);
  const before = query.before ? decodeVaultPositionCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid vault position pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  // WALLET-BINDING SCOPE, applied before the query and therefore before any
  // chain read. A selected-wallet key must not hydrate — or even learn of —
  // positions held by wallets it is not bound to. See the helper for the id
  // spaces this translates between.
  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];
  if (custodyWalletIds.length === 0) {
    return success(c, { positions: [], hasMore: false, nextCursor: null });
  }

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const page = await repo.listVaultPositions({
    organizationId: auth.organizationId,
    environment,
    custodyWalletIds,
    limit: query.limit,
    before,
  });
  const hasMore = page.hasMore;
  // Normalised once, so the instrument columns are proven non-null here rather
  // than at each of the six places below that would otherwise have to coerce
  // them — and a hydration request is never built against a blank vault address.
  const rows = page.rows.map(toVaultHolding);

  const walletAddresses = new Map(
    scopedWallets.map((wallet) => [wallet.id, wallet.publicKey] as const)
  );
  const live = await hydrateVaultPositions(
    c,
    environment,
    rows.map((row) => {
      const ownerAddress = walletAddresses.get(row.custodyWalletId);
      if (!ownerAddress) {
        throw internalError(`Earn vault position ${row.id} has no readable custody owner`);
      }
      return {
        id: row.id,
        provider: row.provider,
        providerReference: row.vaultAddress,
        ownerAddress,
        tokenMint: row.tokenMint,
        shareMint: row.shareMint,
      };
    })
  );

  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeVaultPositionCursor(last.createdAt, last.id) : null;

  return success(c, {
    positions: rows.map((row) => {
      const hydrated = live.get(row.id);
      return {
        id: row.id,
        provider: row.provider,
        providerReference: row.vaultAddress,
        label: row.label,
        custodyWalletId: row.custodyWalletId,
        tokenMint: row.tokenMint,
        shareMint: row.shareMint,
        createdAt: row.createdAt,
        closedAt: row.closedAt,
        // Absent (not zero) when the chain read failed or returned nothing.
        shares: hydrated?.shares,
        withdrawableShares: hydrated?.withdrawableShares,
        tokenValue: hydrated?.tokenValue,
      };
    }),
    hasMore,
    nextCursor,
  });
}

// ---------------------------------------------------------------------------
// Vault withdrawals — the exit half of the vault-direct model (PRO-1702).
// ---------------------------------------------------------------------------

type EarnVaultWithdrawalBody = z.output<typeof earnVaultWithdrawalSchema>;

interface EarnVaultWithdrawalResolved {
  position: VaultHolding;
  wallet: CustodyRuntimeWalletProjection;
  auth: ApiKeyContext;
  projectId: string;
  environment: SdpEnvironment;
  requestId: string | null;
  idempotencyFingerprint: string;
}

/**
 * Parse and resolve a vault withdrawal into its wallet-operation policy
 * candidate — the same trusted-context-before-the-gate rule as the deposit's.
 *
 * WHAT IS DELIBERATELY MISSING is the point (ADR 0002 exit safety, "money out
 * beats money off"): no surfacing gate, no entitlement gate, no availability
 * gate, no environment capability, no catalogue lookup and no admission check.
 * The caller names its own POSITION — the org's recorded claim, which carries
 * the vault, the wallet and both mints — so an exit works for a paused
 * strategy, a delisted vault, an un-surfaced or un-entitled provider, and in
 * every environment a position exists in. The only refusals left are the ones
 * that protect the org itself: the position must belong to the caller's org
 * and environment (404), the key binding must carry a write scope for the
 * signing wallet, and the org's own wallet policy still runs. A shared
 * organization-level custody wallet intentionally lets sibling projects exit
 * the same org-owned position, matching the deposit route's wallet boundary.
 */
export async function extractEarnVaultWithdrawalPolicyCandidate(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalSchema>
): Promise<PolicyGateExtraction> {
  const rawBody: Record<string, unknown> = await c.req.json();
  const body = c.req.valid("json");

  const requestId = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  if (requestId === null && !isDryRunRequest(c)) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for vault withdrawals`);
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  // The org's own claim row, org+environment-scoped in the query (404 for a
  // foreign or sandbox/production-crossed id), narrowed to the vault shape with
  // its instrument columns proven present.
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const positionRow = await repo.getPositionById({
    organizationId: auth.organizationId,
    environment,
    positionId: body.positionId,
  });
  if (positionRow?.kind !== "vault_direct") {
    throw notFound("Earn vault position");
  }
  const position = toVaultHolding(positionRow);

  // The signing wallet comes from the POSITION, never the body: a withdrawal
  // returns shares to tokens in the wallet that holds them, and letting a
  // caller name a different wallet would be a transfer wearing an exit's
  // clothes. Same binding rules as the deposit — the projection must be
  // visible to this project, unambiguous for a selected-scope key, and bound
  // with a WRITE scope.
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
    includeAllProviders: true,
  });
  const wallet = resolveEarnVaultCustodyWallet(wallets, position.custodyWalletId);
  assertBoundWalletIdentifierIsUnique(auth, wallets, wallet);
  assertApiKeyWalletAccess(auth, wallet.walletId, ["earn:write"]);

  const resolved: EarnVaultWithdrawalResolved = {
    position,
    wallet,
    auth,
    projectId,
    environment,
    requestId,
    idempotencyFingerprint: buildEarnVaultWithdrawalFingerprint({
      environment,
      provider: position.provider,
      positionId: position.id,
      shares: body.shares,
      minAmountOut: body.minAmountOut ?? null,
    }),
  };

  return {
    candidate: {
      organizationId: auth.organizationId,
      projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: auth.apiKeyId ?? null,
      actor: walletOperationActorFromAuth(auth),
      source: "earn_vault_withdrawal",
      // Same family as the deposit: an interaction with an on-chain program,
      // with the proceeds returning to the same custody wallet.
      operationFamily: "program",
      operationType: "earn_vault_withdrawal",
      // The SHARE mint: it is the asset this operation actually moves out of
      // the wallet (the deposit token comes back IN), so an asset-scoped rule
      // sees what is being spent.
      asset: position.shareMint,
      amount: body.shares,
      // The vault account — the instrument the shares are redeemed against.
      destination: position.vaultAddress,
      context: {
        provider: position.provider,
        positionId: position.id,
        tokenMint: position.tokenMint,
        environment,
        depositStyle: "vault_direct",
      },
      providerExtensions: {},
    },
    legs: [],
    body,
    resolved,
    rawPayload: {
      ...rawBody,
      idempotencyFingerprint: resolved.idempotencyFingerprint,
    },
    idempotencyKey: requestId,
  };
}

/** Resolve both durable withdrawal-group replays and pre-execution policy replays. */
export async function findEarnVaultWithdrawalIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  // An approval executor must pass through policy resume and the handler's
  // effect fence, even when the domain movements were already recorded.
  if (approvedWalletOperationId(c)) return null;

  const resolved = extraction.resolved as EarnVaultWithdrawalResolved;
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const movement = await repo.findVaultMovementByRequestId({
    organizationId: resolved.auth.organizationId,
    requestId: idempotencyKey,
  });
  if (movement) {
    // Same project boundary and same conflict-shape as the deposit's replay:
    // the vault anchor is org-scoped, so a sibling project's key must answer
    // as "key already used", never with the sibling's movements.
    if (
      !isMovementInProject(movement, resolved.projectId) ||
      movement.idempotency_fingerprint !== resolved.idempotencyFingerprint
    ) {
      throw conflict("Idempotency key already used with different request payload");
    }
    if (!movement.signature) {
      throw internalError(`Replayed withdrawal ${movement.id} has no transaction details`);
    }
    if (movement.status === "failed") {
      throw conflict("The recorded vault withdrawal failed and cannot be replayed");
    }
    return success(
      c,
      buildEarnVaultWithdrawalResponse({
        movement,
        replayed: true,
      })
    );
  }

  await throwOnPriorVaultPolicyOperation(c, {
    organizationId: resolved.auth.organizationId,
    projectId: resolved.projectId,
    idempotencyKey,
    idempotencyFingerprint: resolved.idempotencyFingerprint,
    operationNoun: "vault withdrawal",
  });
  return null;
}

/**
 * POST /v1/earn/vault-withdrawal-previews — what redeeming these shares would
 * pay right now, from the provider's own live accounting. The dashboard derives
 * its `minAmountOut` floor from this quote, exactly as the deposit preview
 * feeds the deposit floor.
 *
 * EXIT gates only (ADR 0002): position scoping and the read-side wallet
 * binding, both answering 404 — no surfacing, no entitlement, no admission and
 * no environment capability, because a quote in service of money-OUT must be
 * reachable for a paused strategy, an un-surfaced provider and a revoked
 * override alike. The only provider-shaped refusal is capability (501).
 */
export async function createEarnVaultWithdrawalPreview(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalPreviewSchema>
) {
  const body = c.req.valid("json");
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const positionRow = await repo.getPositionById({
    organizationId: auth.organizationId,
    environment,
    positionId: body.positionId,
  });
  if (positionRow?.kind !== "vault_direct") {
    throw notFound("Earn vault position");
  }
  const position = toVaultHolding(positionRow);

  // The same binding scope as every vault read: a key bound away from the
  // holding wallet must not learn anything through its position.
  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  if (!scopedWallets.some((wallet) => wallet.id === position.custodyWalletId)) {
    throw notFound("Earn vault position");
  }

  const deadline = createVaultDeadline();
  const client = resolveVaultWithdrawClient(c.env, position.provider, deadline);
  if (!client || !supportsVaultWithdrawQuote(client)) {
    throw notImplemented(position.provider, "vault withdrawal quoting");
  }

  let quote: EarnVaultWithdrawQuote;
  try {
    quote = await client.quoteVaultWithdrawal(earnRuntime(c), {
      providerReference: position.vaultAddress,
      shares: body.shares,
    });
  } catch (error) {
    // An unusable share count is the CALLER's, in the provider's own words —
    // the same shared refusal vocabulary the deposit quote maps through.
    const refusal = refusedBuildMessage(error);
    if (refusal !== null) throw badRequest(refusal);
    throw error;
  }

  return success(c, {
    positionId: position.id,
    assetsOut: quote.assetsOut,
    assetDecimals: quote.assetDecimals,
    blockingIssues: quote.blockingIssues,
  });
}

/**
 * POST /v1/earn/vault-withdrawals — exit a vault position, signed by the
 * custody wallet that holds it. Build, simulate, sign, record, then broadcast;
 * the reconciliation sweep finishes an ambiguous send.
 */
export async function createEarnVaultWithdrawal(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalSchema>
) {
  const { body: parsedData, resolved } = getPolicyGateContext<
    EarnVaultWithdrawalBody,
    EarnVaultWithdrawalResolved
  >(c);
  const { position, wallet, auth, projectId, environment } = resolved;
  const requestId = resolved.requestId;
  if (requestId === null) {
    throw internalError(
      "Vault withdrawal execution reached the handler without an idempotency key"
    );
  }

  const result = await withdrawFromVault(
    c.env,
    {
      organizationId: auth.organizationId,
      projectId,
      environment,
      provider: position.provider,
      positionId: position.id,
      vaultAddress: position.vaultAddress,
      tokenMint: position.tokenMint,
      shareMint: position.shareMint,
      wallet,
      shares: parsedData.shares,
      minAmountOut: parsedData.minAmountOut,
      requestId,
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    },
    {
      runIntentTransaction: (mutation) => runApprovedWalletOperationEffectTransaction(c, mutation),
    }
  );

  if (result.replayed && approvedWalletOperationId(c)) {
    // Sequential replays do not pass through the insert transaction, so fence
    // the approved operation before returning its durable outcome.
    await beginApprovedWalletOperationEffect(c);
    if (!result.movement.signature || result.movement.status === "failed") {
      throw conflict(
        "Approved vault withdrawal execution is incomplete and requires manual reconciliation"
      );
    }
  }

  return success(
    c,
    buildEarnVaultWithdrawalResponse({
      movement: result.movement,
      replayed: result.replayed,
    })
  );
}

function buildEarnVaultWithdrawalResponse(input: {
  movement: EarnMovementRow;
  replayed: boolean;
}): { withdrawal: EarnVaultWithdrawal } {
  return {
    withdrawal: toEarnVaultWithdrawal(input.movement, input.replayed),
  };
}

/**
 * Shared row to wire mapping for withdrawal reads. Speaks the ledger's own
 * status vocabulary. This surface postdates
 * the unified ledger, so there is no legacy client to translate for, and
 * `finalized` finally has its own name on the wire.
 */
function toEarnVaultWithdrawal(movement: EarnMovementRow, replayed?: boolean): EarnVaultWithdrawal {
  if (!movement.vault_address || !movement.signature) {
    throw internalError(`Earn vault withdrawal ${movement.id} is missing execution details`);
  }
  return {
    movementId: movement.id,
    positionId: movement.position_id,
    provider: movement.provider,
    providerReference: movement.vault_address,
    status: movement.status as EarnVaultWithdrawal["status"],
    signature: movement.signature,
    shares: movement.amount_requested,
    shareMint: movement.denomination,
    failureReason: movement.failure_reason,
    createdAt: movement.created_at,
    confirmedAt: movement.confirmed_at,
    settledAt: movement.settled_at,
    ...(replayed === undefined ? {} : { replayed }),
  };
}

/**
 * GET /v1/earn/vault-withdrawals/:movementId - one recorded withdrawal.
 *
 * Same contract as the deposit detail read, mirrored: NO provider gate (it
 * reports on an exit already signed from the org's own wallet), and the same
 * four scoping rules all answering 404 — organization (in the query),
 * environment, project (exact match), and DIRECTION, which now guards the
 * opposite side: a deposit reached by a guessed id is not a withdrawal.
 */
export async function getEarnVaultWithdrawal(c: AppContext) {
  const { movementId } = parseParams(c, earnVaultWithdrawalParamsSchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const movement = await repo.getMovementById({
    movementId,
    organizationId: auth.organizationId,
  });
  if (
    !movement ||
    movement.environment !== environment ||
    movement.execution_model !== "vault_direct" ||
    movement.direction !== "withdrawal" ||
    !isMovementInProject(movement, projectId)
  ) {
    throw notFound("Earn vault withdrawal");
  }

  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  if (!scopedWallets.some((wallet) => wallet.id === movement.custody_wallet_id)) {
    throw notFound("Earn vault withdrawal");
  }

  const currentMovement = await reconcileEarnVaultMovementReadThrough(c.env, movement);
  const response: EarnVaultWithdrawalResponse = {
    withdrawal: toEarnVaultWithdrawal(currentMovement),
  };
  return success(c, response);
}

/**
 * GET /v1/earn/vault-withdrawals - this workspace's recorded withdrawals,
 * newest first: the deposits list's mirror, with the same discovery duty
 * (`?requestId=` finds a movement, including one an approval executor
 * created after the original request was parked) and the same recovery filter
 * (`?settled=false`). Wire statuses are the ledger's own — `settled` here
 * means the LEDGER's terminal set, where `confirmed` is still in flight.
 */
export async function listEarnVaultWithdrawals(c: AppContext) {
  const query = parseQuery(c, earnVaultWithdrawalsQuerySchema);
  const before = query.before ? decodeVaultMovementCursor(query.before) : null;
  if (query.before && !before) {
    throw badRequest("Invalid vault withdrawal pagination cursor");
  }
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const scopedWallets = await listReadableEarnVaultWallets(c, auth, projectId);
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];
  if (custodyWalletIds.length === 0) {
    return success(c, { withdrawals: [], hasMore: false, nextCursor: null });
  }
  const scopedWalletIds = new Set(custodyWalletIds);
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));

  // The single-key lookup resolves one withdrawal movement.
  if (query.requestId !== undefined) {
    const movement = await repo.findVaultMovementByRequestId({
      organizationId: auth.organizationId,
      requestId: query.requestId,
    });
    const visible =
      movement !== null &&
      movement.environment === environment &&
      movement.direction === "withdrawal" &&
      isMovementInProject(movement, projectId) &&
      movement.custody_wallet_id !== null &&
      scopedWalletIds.has(movement.custody_wallet_id);
    return success(c, {
      withdrawals: visible && movement ? [toEarnVaultWithdrawal(movement)] : [],
      hasMore: false,
      nextCursor: null,
    });
  }

  const { rows, hasMore } = await repo.listVaultMovements({
    organizationId: auth.organizationId,
    environment,
    projectId,
    custodyWalletIds,
    direction: "withdrawal",
    limit: query.limit,
    before,
    settled: query.settled,
  });

  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null;
  const withdrawals = rows.map((movement) => toEarnVaultWithdrawal(movement));
  const response: EarnVaultWithdrawalsPage = {
    withdrawals,
    hasMore,
    nextCursor,
  };
  return success(c, response);
}
