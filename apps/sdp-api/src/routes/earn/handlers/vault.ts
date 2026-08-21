import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import { isDecimalString } from "@sdp/solana/amount";
import type {
  EarnVaultDepositRecord,
  EarnVaultDepositResponse,
  EarnVaultDepositsPage,
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
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  walletNotFound,
} from "@/lib/errors";
import { buildEarnVaultDepositFingerprint } from "@/lib/idempotency";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";
import { earnClusterFor, resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
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
  type earnVaultDepositSchema,
  earnVaultDepositsQuerySchema,
  earnVaultPositionsQuerySchema,
} from "../schemas";
import { assertStrategyDepositable } from "./admission";
import { parseParams, parseQuery } from "./shared";

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
  // SDP can move money INTO a vault and not back out: there is no vault
  // withdraw route. The dashboard surfaces the durable position but disables
  // its exit action, so production remains refused server-side. Entitlement
  // cannot express this — it is org-scoped, not environment-scoped — which is
  // exactly why an entitled org would otherwise reach mainnet. The dashboard
  // hides the affordance from the same constant, so the button and the route
  // agree by construction.
  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Vault deposits are not available in production yet: SDP has no vault-withdraw path, " +
        "so a position opened here could not be exited through SDP."
    );
  }

  // SLIPPAGE FLOOR, required wherever real money moves.
  //
  // Kamino's pinned SDK selects the LEGACY deposit instruction when no
  // `minSharesOut` is given — there is no implicit floor, so a vault-state
  // change between signing and inclusion can mint materially fewer shares than
  // the caller reviewed. The dashboard does not yet quote one (that needs a
  // live rate with a displayed tolerance and an expiry), so requiring it
  // unconditionally today would break the only working flow.
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

  // Shape check before anything else: a custodial provider reaching this route
  // would silently skip its wallet-provisioning model.
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

  // MONEY-IN GATES, in the same order and with the same meaning as
  // `POST /programs` (see routes/earn/CLAUDE.md → "Gate asymmetry"). Opening a
  // vault position is a new commitment, so it takes all of:
  //
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
  // Money-OUT must never inherit any of these (ADR 0002): un-offering a
  // provider closes the door in, never the door out.
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
    idempotencyFingerprint: buildEarnVaultDepositFingerprint({
      environment,
      provider,
      providerReference: strategy.provider_reference,
      custodyWalletId: wallet.id,
      amount: body.amount,
      minSharesOut: body.minSharesOut ?? null,
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
      // The DEPOSIT token, from the catalogue row. Named so an asset-scoped
      // rule ("never move USDT") can see what is actually moving.
      asset: tokenMint,
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
    .bind(resolved.auth.organizationId, resolved.projectId, idempotencyKey)
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
  if (!prior) return null;
  if (prior.raw_payload.idempotencyFingerprint !== resolved.idempotencyFingerprint) {
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
        : "Approved vault deposit execution is still in progress",
      details
    );
  }
  if (prior.decision === "deny" || prior.status === "canceled") {
    throw new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
  }
  throw conflict("The prior vault deposit policy operation has no replayable movement");
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
 *   direction    — a `withdraw` movement is not a deposit. The column is the
 *                  only thing separating the two on a shared table, and the
 *                  vault withdraw path is still unbuilt, so this closes the
 *                  path before there is anything to leak through it.
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

  const response: EarnVaultDepositResponse = { deposit: toEarnVaultDepositRecord(movement) };
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

  const { rows, hasMore } = await repo.listVaultDeposits({
    organizationId: auth.organizationId,
    environment,
    projectId,
    custodyWalletIds,
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

  // Group by provider so each client reads its whole shelf in one pass, sharing
  // one slot across the vaults — a per-position read would price a multi-vault
  // page against drifting slots.
  const byProvider = new Map<string, typeof rows>();
  for (const row of rows) {
    const providerRows = byProvider.get(row.provider);
    if (providerRows) providerRows.push(row);
    else byProvider.set(row.provider, [row]);
  }

  const walletAddresses = new Map(
    scopedWallets.map((wallet) => [wallet.id, wallet.publicKey] as const)
  );
  const live = new Map<
    string,
    {
      shares: string;
      tokenValue: string | undefined;
    }
  >();
  const hydrationJobs: Array<() => Promise<void>> = [];
  const deadline = createVaultDeadline();

  for (const [provider, providerRows] of byProvider) {
    const client = resolveVaultDirectClient(c.env, provider, deadline);
    if (!client) continue;
    const byWallet = new Map<string, typeof rows>();
    for (const row of providerRows) {
      const walletRows = byWallet.get(row.custodyWalletId);
      if (walletRows) walletRows.push(row);
      else byWallet.set(row.custodyWalletId, [row]);
    }
    for (const [walletId, walletRows] of byWallet) {
      const owner = walletAddresses.get(walletId);
      if (!owner) continue;
      const trustedIdentity = new Map(
        walletRows.map((row) => [
          row.vaultAddress,
          { tokenMint: row.tokenMint, shareMint: row.shareMint },
        ])
      );
      const references = walletRows.map((row) => row.vaultAddress);
      hydrationJobs.push(async () => {
        const snapshots = await client.readVaultPositions(earnRuntime(c), {
          owner,
          providerReferences: references,
        });
        for (const snapshot of snapshots) {
          const trusted = trustedIdentity.get(snapshot.providerReference);
          if (
            !trusted ||
            snapshot.owner !== owner ||
            snapshot.cluster !== earnClusterFor(environment) ||
            snapshot.tokenMint !== trusted.tokenMint ||
            snapshot.shareMint !== trusted.shareMint ||
            !isBoundedSnapshotAmount(snapshot.shares) ||
            (snapshot.tokenValue !== undefined && !isBoundedSnapshotAmount(snapshot.tokenValue))
          ) {
            getLogger().warn(
              {
                provider,
                walletId,
                providerReference: snapshot.providerReference,
                snapshotOwner: snapshot.owner,
                snapshotCluster: snapshot.cluster,
                snapshotTokenMint: snapshot.tokenMint,
                snapshotShareMint: snapshot.shareMint,
              },
              "vault position: ignored live snapshot with mismatched identity"
            );
            continue;
          }
          live.set(vaultPositionLiveKey(provider, walletId, snapshot.providerReference), {
            shares: snapshot.shares,
            tokenValue: snapshot.tokenValue,
          });
        }
      });
    }
  }

  if (hydrationJobs.length > 0) {
    // Failed reads intentionally leave only their rows unhydrated; never report
    // zero when the chain could not be read. In-flight RPC work stays bounded.
    await mapSettledWithConcurrency(hydrationJobs, 8, (hydrate) => hydrate());
  }

  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeVaultPositionCursor(last.createdAt, last.id) : null;

  return success(c, {
    positions: rows.map((row) => {
      const hydrated = live.get(
        vaultPositionLiveKey(row.provider, row.custodyWalletId, row.vaultAddress)
      );
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
        tokenValue: hydrated?.tokenValue,
      };
    }),
    hasMore,
    nextCursor,
  });
}

function vaultPositionLiveKey(provider: string, walletId: string, reference: string): string {
  return JSON.stringify([provider, walletId, reference]);
}

function isBoundedSnapshotAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && isDecimalString(value);
}

const vaultPositionCursorSchema = z.object({
  // `created_at` is ordered as canonical UTC text, so accepting offsets or a
  // different precision would make a syntactically valid cursor sort wrongly.
  createdAt: z.string().datetime({ precision: 3 }),
  // Shape and bound only, for the same reason as the movement cursor above:
  // holdings carry `earn_vault_position_…` ids the unification preserved beside
  // `earn_position_…` for newer ones. Lowercase is still asserted because
  // PostgreSQL compares the prefixed id as text in the keyset tuple.
  id: z
    .string()
    .min(1)
    .max(128)
    .refine((id) => id === id.toLowerCase()),
});

function encodeVaultPositionCursor(createdAt: string, id: string): string {
  return encodeKeysetCursor(createdAt, id);
}

function decodeVaultPositionCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = decodeKeysetCursor(cursor);
  if (!decoded) return null;
  const parsed = vaultPositionCursorSchema.safeParse({ createdAt: decoded.value, id: decoded.id });
  return parsed.success ? parsed.data : null;
}
