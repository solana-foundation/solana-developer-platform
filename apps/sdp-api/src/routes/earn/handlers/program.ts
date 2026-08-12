import { resolveEarnProviderClient, supportsPortfolioWallets } from "@sdp/earn";
import { notImplemented } from "@sdp/earn/errors";
import type { EarnPortfolioWalletProvider } from "@sdp/earn/types";
import type {
  EarnPortfolioAllocationInput,
  EarnPortfolioDepositsPage,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalPreview,
  EarnPortfolioYield,
  EarnProgramWithdrawalRecord,
  ListEarnProgramWithdrawalsResponse,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  EarnProgramWithdrawalRow,
  EarnProviderWalletRow,
  EarnRepository,
} from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import {
  buildEarnWithdrawalFingerprint,
  deriveProviderRequestId,
  resolveIdempotencyReplay,
} from "@/lib/idempotency";
import { success } from "@/lib/response";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getLogger } from "@/runtime/logger";
import {
  applyEarnWithdrawalObservationByReference,
  applyEarnWithdrawalObservationToRow,
} from "@/services/earn-withdrawal-ledger.service";
import {
  assertEarnProviderConfigured,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import { type AppContext, earnRuntime, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnProgramDepositsQuerySchema,
  earnProgramQuerySchema,
  earnProgramUpsertSchema,
  earnProgramWithdrawalCreateSchema,
  earnProgramWithdrawalParamsSchema,
  earnProgramWithdrawalPreviewSchema,
  earnProgramWithdrawalsListQuerySchema,
} from "../schemas";
import { listResponse, pageWindow, parseBody, parseParams, parseQuery } from "./shared";

/**
 * The shared earn "program": ONE provider-managed portfolio wallet per
 * (organization, environment, provider). PUT is idempotent create-or-update —
 * first call provisions the provider wallet and persists the link row, later
 * calls rewrite the wallet's strategy weights.
 *
 * Source of truth per surface (PRO-1628): balances/positions/yield/deposits
 * are NEVER persisted — every read is a live provider fetch. Withdrawals are
 * the one money movement SDP initiates, so they get a ledger row
 * (earn_program_withdrawals): written at intent, advanced on every
 * observation, listed from the DB. No endpoint ever blends the two sources —
 * create/get answer with the provider's live object and update the ledger as
 * a side effect; the list answers from the ledger alone.
 *
 * Gate asymmetry (ADR 0002 exit safety): PUT is money-in and takes the full
 * entitled+configured availability gate; withdrawal endpoints only require
 * provider credentials so disabling a provider can never trap funds; plain
 * reads also only require credentials (they hit the provider's API); the
 * ledger list takes no provider gate at all — the audit trail outlives even
 * credential removal.
 */

// Response envelopes (route-owned until a second surface needs them in @sdp/types).
export interface EarnProgram {
  provider: string;
  label: string | null;
  createdAt: string;
  wallet: EarnPortfolioWalletSnapshot;
  /**
   * Yield metrics, absent when the provider's yield endpoint fails. Balances
   * are the load-bearing part of this response, so a yield outage degrades the
   * headline rate rather than the whole program view.
   */
  yield?: EarnPortfolioYield;
}

export interface EarnProgramResponse {
  program: EarnProgram;
}

export interface EarnProgramUpsertResponse extends EarnProgramResponse {
  created: boolean;
}

export type EarnProgramDepositsResponse = EarnPortfolioDepositsPage;

export interface EarnProgramWithdrawalPreviewResponse {
  preview: EarnPortfolioWithdrawalPreview;
}

export interface EarnProgramWithdrawalResponse {
  withdrawal: EarnPortfolioWithdrawal;
}

function mapProgram(
  row: EarnProviderWalletRow,
  wallet: EarnPortfolioWalletSnapshot,
  portfolioYield?: EarnPortfolioYield
): EarnProgram {
  return {
    provider: row.provider,
    label: row.label,
    createdAt: row.created_at,
    wallet,
    ...(portfolioYield ? { yield: portfolioYield } : {}),
  };
}

/**
 * Wallet snapshot + yield in one round trip each, fetched together because the
 * dashboard renders them as one view. Yield is best-effort: the rate is a
 * headline nicety, while balances and positions are what the page is for.
 */
async function loadProgramState(
  c: AppContext,
  client: EarnPortfolioWalletProvider,
  providerWalletRef: string
): Promise<{ wallet: EarnPortfolioWalletSnapshot; portfolioYield?: EarnPortfolioYield }> {
  const runtime = earnRuntime(c);
  const [wallet, yieldResult] = await Promise.all([
    client.getPortfolioWallet(runtime, { providerWalletRef }),
    client.getPortfolioYield(runtime, { providerWalletRef }).catch((error: unknown) => {
      getLogger().warn(
        { err: error, providerWalletRef },
        "earn program yield lookup failed; serving balances without a rate"
      );
      return undefined;
    }),
  ]);
  return { wallet, portfolioYield: yieldResult };
}

/**
 * Capability gate: the portfolio-wallet contract is optional per provider, so
 * narrow via the method-presence guard — never by matching provider ids — and
 * fail with a clean 501 for providers that only implement the vault contract.
 */
function requirePortfolioClient(provider: EarnProviderId): EarnPortfolioWalletProvider {
  const client = resolveEarnProviderClient(provider);
  if (!supportsPortfolioWallets(client)) {
    throw notImplemented(client.provider, "portfolio wallets");
  }
  return client;
}

async function requireProgramWallet(
  c: AppContext,
  provider: EarnProviderId
): Promise<EarnProviderWalletRow> {
  const row = await getEarnRepository(c).getProviderWallet({
    organizationId: getAuth(c).organizationId,
    environment: resolveSdpEnvironment(c),
    provider,
  });

  if (!row) {
    throw notFound("Earn program");
  }

  return row;
}

/**
 * Allocation targets must reference catalogue rows the sync currently lists as
 * active for this provider+environment — the cron re-asserts `active` on every
 * listed source, so anything else is either unknown or no longer depositable.
 */
async function assertKnownYieldSources(
  c: AppContext,
  provider: EarnProviderId,
  allocations: EarnPortfolioAllocationInput
): Promise<void> {
  const requested = new Set<string>();
  for (const group of Object.values(allocations)) {
    for (const { yieldSourceId } of group ?? []) {
      requested.add(yieldSourceId);
    }
  }

  const repo = getEarnRepository(c);
  const environment = resolveSdpEnvironment(c);
  const known = new Set<string>();
  const pageSize = 200;
  // The repository has no provider filter, so page the (small) environment
  // catalogue and match provider rows in memory.
  for (let offset = 0; ; offset += pageSize) {
    const { rows, total } = await repo.listStrategies({ environment, limit: pageSize, offset });
    for (const row of rows) {
      if (row.provider === provider) {
        known.add(row.provider_reference);
      }
    }
    if (rows.length === 0 || offset + pageSize >= total) {
      break;
    }
  }

  const unknown = [...requested].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw badRequest(`Unknown or inactive yield sources for provider ${provider}`, {
      unknownYieldSourceIds: unknown,
    });
  }
}

export const upsertEarnProgram = async (c: AppContext) => {
  const body = await parseBody(c, earnProgramUpsertSchema);
  const client = requirePortfolioClient(body.provider);
  const auth = getAuth(c);
  const environment = resolveSdpEnvironment(c);

  // Money-in gate: full entitlement + mode-specific credential check.
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    client.provider,
    environment === "sandbox"
  );
  await assertKnownYieldSources(c, client.provider, body.allocations);

  const repo = getEarnRepository(c);
  const existing = await repo.getProviderWallet({
    organizationId: auth.organizationId,
    environment,
    provider: client.provider,
  });

  let row = existing;
  if (row) {
    await client.updatePortfolioStrategy(earnRuntime(c), {
      providerWalletRef: row.provider_wallet_ref,
      allocations: body.allocations,
      // Forwarded so a double-submitted confirm re-applies the SAME strategy
      // change instead of firing two independent provider mutations. Absent
      // means the client accepted non-idempotent behaviour (see the schema).
      requestId: body.requestId,
    });
  } else {
    if (!auth.projectId) {
      throw internalError("Could not resolve project scope");
    }
    const createdWallet = await client.createPortfolioWallet(earnRuntime(c), {
      label: body.label ?? `sdp-earn-${auth.organizationId}-${environment}`,
      allocations: body.allocations,
      // Same key on the create branch: without it a retried first PUT can
      // provision a second provider wallet that the unique constraint then
      // orphans.
      requestId: body.requestId,
    });

    try {
      row = await repo.insertProviderWallet({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        environment,
        provider: client.provider,
        providerWalletRef: createdWallet.providerWalletRef,
        label: body.label ?? null,
        createdBy: await resolveCreatorUserId(c),
      });
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        // Concurrent first-PUT race: another request won the unique
        // (org, environment, provider) slot. The losing provider wallet holds
        // no funds (nothing can be deposited before a ref is returned).
        throw conflict("Earn program was provisioned concurrently; retry to update its strategy");
      }
      throw err;
    }
    if (!row) {
      throw internalError("Failed to persist earn program wallet");
    }
  }

  const { wallet, portfolioYield } = await loadProgramState(c, client, row.provider_wallet_ref);

  const response: EarnProgramUpsertResponse = {
    program: mapProgram(row, wallet, portfolioYield),
    created: !existing,
  };
  return success(c, response, existing ? 200 : 201);
};

export const getEarnProgram = async (c: AppContext) => {
  const { provider } = parseQuery(c, earnProgramQuerySchema);
  const client = requirePortfolioClient(provider);
  const row = await requireProgramWallet(c, provider);

  const testMode = resolveSdpEnvironment(c) === "sandbox";
  assertEarnProviderConfigured(c.env, client.provider, testMode);

  const { wallet, portfolioYield } = await loadProgramState(c, client, row.provider_wallet_ref);

  const response: EarnProgramResponse = { program: mapProgram(row, wallet, portfolioYield) };
  return success(c, response);
};

export const listEarnProgramDeposits = async (c: AppContext) => {
  const query = parseQuery(c, earnProgramDepositsQuerySchema);
  const client = requirePortfolioClient(query.provider);
  const row = await requireProgramWallet(c, query.provider);

  const testMode = resolveSdpEnvironment(c) === "sandbox";
  assertEarnProviderConfigured(c.env, client.provider, testMode);

  const response: EarnProgramDepositsResponse = await client.listPortfolioDeposits(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    ...(query.cursor !== undefined && { cursor: query.cursor }),
  });

  return success(c, response);
};

export const previewEarnProgramWithdrawal = async (c: AppContext) => {
  const body = await parseBody(c, earnProgramWithdrawalPreviewSchema);
  const client = requirePortfolioClient(body.provider);
  const row = await requireProgramWallet(c, body.provider);

  // Money-out path: credentials only, never the entitlement gate.
  assertEarnProviderConfigured(c.env, client.provider, resolveSdpEnvironment(c) === "sandbox");

  const preview = await client.previewPortfolioWithdrawal(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    amountUsd: body.amountUsd,
    token: body.token,
  });

  const response: EarnProgramWithdrawalPreviewResponse = { preview };
  return success(c, response);
};

/**
 * The key the provider dedupes this withdrawal on.
 *
 * It must be STABLE across retries of the same intent: the provider replays
 * the original response for a key it has seen and refuses a mismatched
 * payload under it, while a key it has never seen is, correctly, a new
 * withdrawal. The duplicate defence is two-layer (PRO-1628): this derived key
 * is also the anchor of the SDP-side intent row — unique per (wallet,
 * request_id) — so a replayed request resolves against our own ledger before
 * any provider call, and the provider's own dedupe closes whatever a crash
 * window leaves open.
 *
 * A server-minted random id therefore cannot be the fallback: it is fresh per
 * HTTP attempt, so it guarantees exactly the double-send it appears to guard
 * against. Callers get two ways to supply a stable key — an explicit
 * `requestId`, or the platform-wide `Idempotency-Key` header — and a request
 * carrying neither is refused rather than silently made unsafe.
 *
 * Whichever way it arrives, the caller's key is DERIVED against the program
 * wallet rather than forwarded as given. Every SDP organization shares one
 * provider account, so a key is only unique to a tenant once something tenant-
 * specific is mixed in: two organizations pasting the same placeholder UUID
 * would otherwise land on one provider request, and the second would either be
 * refused or answered with a replay of the first organization's withdrawal.
 * The wallet ref is unique per (organization, environment, provider) by DB
 * constraint, so it separates them and names the thing the money leaves.
 *
 * Deriving costs the caller nothing: the same key still reproduces the same
 * provider request on a retry, which is the only property they rely on. The
 * value SDP returns for tracking is the provider's own withdrawal ref, never
 * this id.
 *
 * Exactly ONE source is accepted, and sending both is refused rather than
 * resolved by precedence. Two sources cannot be ranked safely: a client whose
 * retry layer preserves headers while its request layer mints a fresh body id
 * per attempt would keep `Idempotency-Key` stable and vary `requestId`, and
 * any precedence rule silently follows the varying one — a second withdrawal,
 * not a replay. That is the exact failure this function exists to prevent, so
 * ambiguity fails loud at integration time instead of paying out twice in
 * production. Neither source is likewise refused, for the same reason.
 */
function resolveWithdrawalRequestId(
  c: AppContext,
  requestId: string | undefined,
  providerWalletRef: string
): string {
  const headerKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (requestId && headerKey) {
    throw badRequest(
      `Send requestId or the ${IDEMPOTENCY_KEY_HEADER} header, not both: SDP cannot tell which one your retry keeps stable, and following the wrong one would pay out twice.`
    );
  }
  const callerKey = requestId ?? headerKey;
  if (!callerKey) {
    throw badRequest(
      `A withdrawal needs an idempotency key that is stable across retries: send requestId (UUIDv4) or the ${IDEMPOTENCY_KEY_HEADER} header. Without one, a retried request would pay out twice.`
    );
  }
  return deriveProviderRequestId(["earn_program_withdrawal", providerWalletRef], callerKey);
}

const LEDGER_WRITE_ATTEMPTS = 3;

/**
 * Post-acceptance bookkeeping. Money has moved by the time this runs, so the
 * response must NEVER fail on a ledger write: retry briefly, then log with an
 * alertable marker and move on. Heal semantics are honest and narrow — the
 * poll path can only heal rows that already carry provider_reference; a row
 * this function failed to stamp is healed by a same-key create retry or the
 * ledger sweep, never by fuzzy matching.
 */
async function persistWithdrawalObservation(
  repo: EarnRepository,
  intentRow: EarnProgramWithdrawalRow,
  observed: EarnPortfolioWithdrawal
): Promise<void> {
  for (let attempt = 1; attempt <= LEDGER_WRITE_ATTEMPTS; attempt++) {
    try {
      await applyEarnWithdrawalObservationToRow({ repo, row: intentRow, observed });
      return;
    } catch (error) {
      if (attempt === LEDGER_WRITE_ATTEMPTS) {
        getLogger().error(
          {
            err: error,
            marker: "earn_ledger_write_failed",
            rowId: intentRow.id,
            withdrawalRef: observed.withdrawalRef,
          },
          "earn withdrawal ledger write failed after provider acceptance; returning success anyway"
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

export const createEarnProgramWithdrawal = async (c: AppContext) => {
  const body = await parseBody(c, earnProgramWithdrawalCreateSchema);
  const client = requirePortfolioClient(body.provider);
  const row = await requireProgramWallet(c, body.provider);

  // Money-out path: credentials only, never the entitlement gate.
  assertEarnProviderConfigured(c.env, client.provider, resolveSdpEnvironment(c) === "sandbox");

  const auth = getAuth(c);
  const requestId = resolveWithdrawalRequestId(c, body.requestId, row.provider_wallet_ref);
  // The fingerprint normalizes the amount exactly as the provider wire does
  // (clients send a JSON number), so SDP's conflict judgment can never be
  // stricter than the provider request it guards — '100' and '100.00' replay.
  const fingerprint = buildEarnWithdrawalFingerprint({
    providerWalletRef: row.provider_wallet_ref,
    amountUsd: body.amountUsd,
    token: body.token,
    destinationAddress: body.destinationAddress,
  });

  const repo = getEarnRepository(c);
  const findIntentRow = () =>
    repo.getProgramWithdrawalByRequestId({
      organizationId: auth.organizationId,
      walletId: row.id,
      requestId,
    });

  // SDP-side replay resolution BEFORE any provider call: the same key with a
  // different payload 409s here (the provider enforces the identical rule —
  // an idempotency key names one intent); a matching payload resolves to the
  // existing intent row.
  // True replay of an accepted withdrawal: answer with the provider's live
  // state and let the observation refresh the ledger. 200, not 201 — nothing
  // was created by this request.
  const serveReplay = async (intent: EarnProgramWithdrawalRow, providerReference: string) => {
    const withdrawal = await client.getPortfolioWithdrawal(earnRuntime(c), {
      providerWalletRef: row.provider_wallet_ref,
      withdrawalRef: providerReference,
    });
    await persistWithdrawalObservation(repo, intent, withdrawal);
    const response: EarnProgramWithdrawalResponse = { withdrawal };
    return success(c, response, 200);
  };

  let intentRow = await resolveIdempotencyReplay(findIntentRow, fingerprint);

  if (intentRow?.provider_reference) {
    return serveReplay(intentRow, intentRow.provider_reference);
  }

  if (!intentRow) {
    if (!auth.projectId) {
      throw internalError("Could not resolve project scope");
    }
    // Insert-at-intent: the ledger row exists before the provider call, so a
    // crash between here and acceptance leaves a re-drivable 'requested' row
    // (same-key retry or the ledger sweep) instead of an untracked payout.
    try {
      intentRow = await repo.createProgramWithdrawal({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletId: row.id,
        provider: client.provider,
        amountRequestedUsd: body.amountUsd,
        token: body.token,
        destinationAddress: body.destinationAddress,
        requestId,
        idempotencyFingerprint: fingerprint,
        providerData: {},
        createdBy: await resolveCreatorUserId(c),
        initiatedByKeyId: auth.apiKeyId ?? null,
      });
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      // Concurrent same-key race: the other request claimed the (wallet,
      // request_id) slot — re-resolve as a replay. Fingerprint is NOT NULL by
      // schema, so this is always decisive: match, or 409.
      intentRow = await resolveIdempotencyReplay(findIntentRow, fingerprint);
    }
    if (!intentRow) {
      throw internalError("Failed to persist earn withdrawal intent");
    }
    // Lost-race edge: the concurrent same-key winner may have already driven
    // the provider and stamped the ref while we waited on the re-resolve —
    // that is a replay too, not a second create.
    if (intentRow.provider_reference) {
      return serveReplay(intentRow, intentRow.provider_reference);
    }
  }

  // The row is ref-less in every remaining path (fresh intent, or a
  // crash-window replay whose provider call never landed): drive the provider
  // with the SAME derived id — it replays a seen key and first-sends an unseen
  // one, so this can never double-pay.
  const withdrawal = await client.createPortfolioWithdrawal(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    requestId,
    amountUsd: body.amountUsd,
    token: body.token,
    destinationAddress: body.destinationAddress,
  });

  await persistWithdrawalObservation(repo, intentRow, withdrawal);

  const response: EarnProgramWithdrawalResponse = { withdrawal };
  return success(c, response, 201);
};

export const getEarnProgramWithdrawal = async (c: AppContext) => {
  const { withdrawalRef } = parseParams(c, earnProgramWithdrawalParamsSchema);
  const { provider } = parseQuery(c, earnProgramQuerySchema);
  const client = requirePortfolioClient(provider);
  const row = await requireProgramWallet(c, provider);

  assertEarnProviderConfigured(c.env, client.provider, resolveSdpEnvironment(c) === "sandbox");

  const repo = getEarnRepository(c);

  // BOLA guard, defense in depth: every SDP organization shares one provider
  // account, so a foreign org's withdrawal ref must 404 HERE — before any
  // provider call — regardless of how the provider scopes its own lookup
  // (Ground's read is wallet-scoped, but that is the provider's promise, not
  // ours). The ledger knows who owns every ref it has seen; a ref it has
  // never seen (pre-ledger withdrawals) falls through to the provider's
  // wallet-scoped read, which cannot name another wallet's withdrawal.
  const ledgerRow = await repo.getProgramWithdrawalByProviderReference({
    provider: client.provider,
    providerReference: withdrawalRef,
  });
  if (ledgerRow && ledgerRow.organization_id !== getAuth(c).organizationId) {
    throw notFound("Earn withdrawal");
  }

  const withdrawal = await client.getPortfolioWithdrawal(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    withdrawalRef,
  });

  // Persist-on-observation, best effort: the response is the provider's live
  // truth either way, and a bookkeeping failure must never break a read. Rows
  // without provider_reference are invisible to this path by design.
  try {
    await applyEarnWithdrawalObservationByReference({
      repo,
      provider: client.provider,
      organizationId: getAuth(c).organizationId,
      observed: withdrawal,
    });
  } catch (error) {
    getLogger().warn(
      { err: error, withdrawalRef },
      "earn withdrawal observation persist failed; serving live state"
    );
  }

  const response: EarnProgramWithdrawalResponse = { withdrawal };
  return success(c, response);
};

function mapToEarnProgramWithdrawalRecord(
  row: EarnProgramWithdrawalRow
): EarnProgramWithdrawalRecord {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    amountRequestedUsd: row.amount_requested_usd,
    amountPaidUsd: row.amount_paid_usd ?? undefined,
    feeUsd: row.fee_usd ?? undefined,
    token: row.token,
    destinationAddress: row.destination_address,
    failureReason: row.failure_reason ?? undefined,
    withdrawalRef: row.provider_reference ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

/**
 * The withdrawal LEDGER list (source: earn_program_withdrawals, never the
 * provider). Deliberately takes NO provider gate — not even the credential
 * check — because the audit trail must survive credential removal and
 * entitlement disablement. The registry-gated provider query param is request
 * validation, not availability. Wallet-scoped like the ledger itself: every
 * project in the environment shares the program, so one program = one history.
 */
export const listEarnProgramWithdrawals = async (c: AppContext) => {
  const query = parseQuery(c, earnProgramWithdrawalsListQuerySchema);
  const row = await requireProgramWallet(c, query.provider);

  const { rows, total } = await getEarnRepository(c).listProgramWithdrawals({
    organizationId: getAuth(c).organizationId,
    walletId: row.id,
    ...pageWindow(query),
  });

  const response: ListEarnProgramWithdrawalsResponse = listResponse(query, total, {
    withdrawals: rows.map(mapToEarnProgramWithdrawalRecord),
  });
  return success(c, response);
};
