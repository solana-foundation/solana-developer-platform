import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import { isDecimalString } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import {
  type EarnProviderId,
  earnDepositStyle,
  isVaultDirectDepositEnabled,
} from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
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
import { earnVaultDepositSchema, earnVaultPositionsQuerySchema } from "../schemas";
import { assertStrategyDepositable } from "./admission";
import { parseQuery } from "./shared";

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
export async function createEarnVaultDeposit(c: AppContext) {
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
  return {
    positionId: result.position.id,
    movementId: result.movement.id,
    status: result.movement.status,
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
  c: AppContext
): Promise<PolicyGateExtraction> {
  const body = await c.req.json().catch(() => null);
  if (body && typeof body === "object" && Object.hasOwn(body, "requestId")) {
    throw badRequest(`Use the ${IDEMPOTENCY_KEY_HEADER} header; body requestId is not accepted`);
  }
  const parsed = earnVaultDepositSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid vault deposit request", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

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
  // withdraw route, and the Active tab does not surface vault positions. Until
  // both land, opening a position with real funds is a one-way door, so
  // production is refused server-side. Entitlement cannot express this — it is
  // org-scoped, not environment-scoped — which is exactly why an entitled org
  // would otherwise reach mainnet. The dashboard hides the affordance from the
  // same constant, so the button and the route agree by construction.
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
  if (environment === "production" && parsed.data.minSharesOut === undefined) {
    throw badRequest(
      "minSharesOut is required for a production vault deposit: without a floor the pinned " +
        "Kamino SDK builds the legacy deposit instruction, which accepts any number of shares."
    );
  }

  // Resolve the strategy first: the caller names a catalogue row, never a raw
  // vault address. That keeps the deposit target inside what SDP catalogues and
  // means the admission gates the sync applied still bound this path.
  const strategy = await getEarnRepository(c).getStrategyById(parsed.data.strategyId);
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
  const wallet = resolveEarnVaultCustodyWallet(wallets, parsed.data.custodyWalletId);
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
      amount: parsed.data.amount,
      minSharesOut: parsed.data.minSharesOut ?? null,
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
      amount: parsed.data.amount,
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
        minSharesOut: parsed.data.minSharesOut ?? null,
      },
      providerExtensions: {},
    },
    legs: [],
    body: parsed.data,
    resolved,
    rawPayload: {
      ...(body as Record<string, unknown>),
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
  const repo = createPostgresEarnVaultRepository(getDb(c.env));
  const movement = await repo.findMovementByRequestId({
    organizationId: resolved.auth.organizationId,
    requestId: idempotencyKey,
  });
  if (movement) {
    if (movement.idempotency_fingerprint !== resolved.idempotencyFingerprint) {
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
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
    includeAllProviders: true,
  });

  // WALLET-BINDING SCOPE, applied before the query and therefore before any
  // chain read. A selected-wallet key must not hydrate — or even learn of —
  // positions held by wallets it is not bound to.
  //
  // The id spaces differ and that is the trap here: this helper returns PROVIDER
  // wallet ids (`privy_…`), while `earn_vault_positions.custody_wallet_id` is
  // the `custody_wallets` row id (`cwlt_…`). `scope.wallets` carries both, so it
  // is the translation table. Passing the allow-list straight through would
  // match nothing and silently return an empty page — a filter that looks like
  // it works and hides everything.
  const allowedProviderWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["earn:read"]);
  const allowed = allowedProviderWalletIds === null ? null : new Set(allowedProviderWalletIds);
  const scopedProviderWalletCounts = new Map<string, number>();
  for (const wallet of wallets) {
    scopedProviderWalletCounts.set(
      wallet.walletId,
      (scopedProviderWalletCounts.get(wallet.walletId) ?? 0) + 1
    );
  }
  const scopedWallets = wallets.filter(
    (wallet) =>
      allowed === null ||
      (allowed.has(wallet.walletId) && scopedProviderWalletCounts.get(wallet.walletId) === 1)
  );
  const custodyWalletIds = [...new Set(scopedWallets.map((wallet) => wallet.id))];
  if (custodyWalletIds.length === 0) {
    return success(c, { positions: [], hasMore: false, nextCursor: null });
  }

  const repo = createPostgresEarnVaultRepository(getDb(c.env));
  const { rows, hasMore } = await repo.listPositions({
    organizationId: auth.organizationId,
    environment,
    custodyWalletIds,
    limit: query.limit,
    before,
  });

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
      const walletRows = byWallet.get(row.custody_wallet_id);
      if (walletRows) walletRows.push(row);
      else byWallet.set(row.custody_wallet_id, [row]);
    }
    for (const [walletId, walletRows] of byWallet) {
      const owner = walletAddresses.get(walletId);
      if (!owner) continue;
      const trustedIdentity = new Map(
        walletRows.map((row) => [
          row.provider_reference,
          { tokenMint: row.token_mint, shareMint: row.share_mint },
        ])
      );
      const references = walletRows.map((row) => row.provider_reference);
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
  const nextCursor = hasMore && last ? encodeVaultPositionCursor(last.created_at, last.id) : null;

  return success(c, {
    positions: rows.map((row) => {
      const hydrated = live.get(
        vaultPositionLiveKey(row.provider, row.custody_wallet_id, row.provider_reference)
      );
      return {
        id: row.id,
        provider: row.provider,
        providerReference: row.provider_reference,
        label: row.label,
        custodyWalletId: row.custody_wallet_id,
        tokenMint: row.token_mint,
        shareMint: row.share_mint,
        createdAt: row.created_at,
        closedAt: row.closed_at,
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
  // Generated UUIDs are lowercase. Preserve that canonical spelling because
  // PostgreSQL compares the prefixed position id as text in the keyset tuple.
  id: z
    .templateLiteral(["earn_vault_position_", z.uuidv4()])
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
