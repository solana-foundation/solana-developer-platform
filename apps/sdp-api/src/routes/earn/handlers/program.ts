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
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { EarnProviderWalletRow } from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { success } from "@/lib/response";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getLogger } from "@/runtime/logger";
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
} from "../schemas";
import { parseBody, parseParams, parseQuery } from "./shared";

/**
 * The shared earn "program": ONE provider-managed portfolio wallet per
 * (organization, environment, provider). PUT is idempotent create-or-update —
 * first call provisions the provider wallet and persists the link row, later
 * calls rewrite the wallet's strategy weights. Balances/positions are never
 * persisted; every read is a live provider fetch.
 *
 * Gate asymmetry (ADR 0002 exit safety): PUT is money-in and takes the full
 * entitled+configured availability gate; withdrawal endpoints only require
 * provider credentials so disabling a provider can never trap funds; plain
 * reads also only require credentials (they hit the provider's API).
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
 * It must be STABLE across retries of the same intent, because that key is the
 * only thing standing between a retried request and a second payout: the
 * provider replays the original response for a key it has seen and refuses a
 * mismatched payload under it, while a key it has never seen is, correctly, a
 * new withdrawal. SDP stores no row for a withdrawal, so there is no second
 * place to catch a duplicate — this value is the whole mechanism.
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

export const createEarnProgramWithdrawal = async (c: AppContext) => {
  const body = await parseBody(c, earnProgramWithdrawalCreateSchema);
  const client = requirePortfolioClient(body.provider);
  const row = await requireProgramWallet(c, body.provider);

  // Money-out path: credentials only, never the entitlement gate.
  assertEarnProviderConfigured(c.env, client.provider, resolveSdpEnvironment(c) === "sandbox");

  const withdrawal = await client.createPortfolioWithdrawal(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    requestId: resolveWithdrawalRequestId(c, body.requestId, row.provider_wallet_ref),
    amountUsd: body.amountUsd,
    token: body.token,
    destinationAddress: body.destinationAddress,
  });

  const response: EarnProgramWithdrawalResponse = { withdrawal };
  return success(c, response, 201);
};

export const getEarnProgramWithdrawal = async (c: AppContext) => {
  const { withdrawalRef } = parseParams(c, earnProgramWithdrawalParamsSchema);
  const { provider } = parseQuery(c, earnProgramQuerySchema);
  const client = requirePortfolioClient(provider);
  const row = await requireProgramWallet(c, provider);

  assertEarnProviderConfigured(c.env, client.provider, resolveSdpEnvironment(c) === "sandbox");

  const withdrawal = await client.getPortfolioWithdrawal(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    withdrawalRef,
  });

  const response: EarnProgramWithdrawalResponse = { withdrawal };
  return success(c, response);
};
