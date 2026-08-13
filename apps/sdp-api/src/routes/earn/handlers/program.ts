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
  earnProgramCreateSchema,
  earnProgramDepositsQuerySchema,
  earnProgramParamsSchema,
  earnProgramRetargetSchema,
  earnProgramsListQuerySchema,
  earnProgramWithdrawalCreateSchema,
  earnProgramWithdrawalParamsSchema,
  earnProgramWithdrawalPreviewSchema,
  earnProgramWithdrawalsListQuerySchema,
} from "../schemas";
import { listResponse, pageWindow, parseBody, parseParams, parseQuery } from "./shared";

/**
 * Earn "programs": provider-managed portfolio wallets, N per (organization,
 * environment, provider) since PRO-1670, each pinned to a single vault with
 * nothing rebalancing across them. Moving money between programs is explicit —
 * withdraw from one, deposit into the other.
 *
 * Addressing: a program is named by its OWN id. POST creates one, PUT
 * /:programId re-targets that program's vault in place. The pre-PRO-1670
 * `PUT /program` was an implicit create-or-update keyed on (organization,
 * environment, provider), which stops being addressable the moment a second
 * program exists.
 *
 * Because the id is now caller-supplied, every `:programId` lookup carries its
 * own tenancy proof (`getProviderWalletById` scopes to organization AND
 * environment). The old triple lookup made a guessed id structurally
 * impossible; an addressable id does not, so the scoping is explicit.
 *
 * Source of truth per surface (PRO-1628): balances/positions/yield/deposits
 * are NEVER persisted — every read is a live provider fetch. Withdrawals are
 * the one money movement SDP initiates, so they get a ledger row
 * (earn_program_withdrawals): written at intent, advanced on every
 * observation, listed from the DB. No endpoint ever blends the two sources —
 * create/get answer with the provider's live object and update the ledger as
 * a side effect; the list answers from the ledger alone.
 *
 * Gate asymmetry (ADR 0002 exit safety): create and re-target are money-in and
 * take the full entitled+configured availability gate; withdrawal endpoints
 * only require provider credentials so disabling a provider can never trap
 * funds; plain reads also only require credentials (they hit the provider's
 * API); the ledger list takes no provider gate at all — the audit trail
 * outlives even credential removal.
 */

// Response envelopes (route-owned until a second surface needs them in @sdp/types).
export interface EarnProgram {
  /** SDP's own program id — how every `/programs/:programId` route names it. */
  id: string;
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

export interface ListEarnProgramsResponse {
  programs: EarnProgram[];
  total: number;
  page: number;
  pageSize: number;
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
    id: row.id,
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
 *
 * Takes a plain string because on every `:programId` route the provider now
 * comes from the stored row, and stored provider ids are open TEXT (ADR 0002
 * drift rule): a row can outlive its provider's registry entry.
 * `resolveEarnProviderClient` is the fail-closed dispatch for exactly that —
 * an unregistered id raises PROVIDER_NOT_CONFIGURED rather than a 500.
 */
function requirePortfolioClient(provider: string): EarnPortfolioWalletProvider {
  const client = resolveEarnProviderClient(provider);
  if (!supportsPortfolioWallets(client)) {
    throw notImplemented(client.provider, "portfolio wallets");
  }
  return client;
}

/**
 * Resolve the path program, scoped to the caller's organization AND
 * environment. A miss is 404 in every case — a foreign organization's id, a
 * sandbox id presented by a production session, and a plain typo are
 * indistinguishable to the caller on purpose.
 */
async function requireProgram(c: AppContext, programId: string): Promise<EarnProviderWalletRow> {
  const row = await getEarnRepository(c).getProviderWalletById({
    organizationId: getAuth(c).organizationId,
    environment: resolveSdpEnvironment(c),
    walletId: programId,
  });

  if (!row) {
    throw notFound("Earn program");
  }

  return row;
}

/**
 * The `:programId` preamble every per-program route shares: row, client, and
 * the sandbox/production mode the credential checks key off — resolved once
 * here so handlers cannot drift on which environment they assert against.
 */
async function requireProgramContext(
  c: AppContext,
  programId: string
): Promise<{ row: EarnProviderWalletRow; client: EarnPortfolioWalletProvider; testMode: boolean }> {
  const row = await requireProgram(c, programId);
  return {
    row,
    client: requirePortfolioClient(row.provider),
    testMode: row.environment === "sandbox",
  };
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

/**
 * The caller's retry-stable idempotency key, from AT MOST one of body
 * `requestId` or the `Idempotency-Key` header; undefined when neither is sent.
 *
 * Two sources cannot be ranked safely: a client whose retry layer preserves
 * headers while its request layer mints a fresh body id per attempt would keep
 * `Idempotency-Key` stable and vary `requestId`, and any precedence rule
 * silently follows the varying one — a second operation, not a replay. So
 * ambiguity fails loud at integration time. Every route in this family that
 * takes a key resolves it HERE, so the header is honored (or refused) the same
 * way everywhere — the platform middleware validates and echoes it on every
 * /v1/* response, and a route that silently dropped it would look keyed while
 * being fresh per attempt.
 */
function resolveCallerIdempotencyKey(
  c: AppContext,
  requestId: string | undefined,
  consequence: string
): string | undefined {
  const headerKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (requestId && headerKey) {
    throw badRequest(
      `Send requestId or the ${IDEMPOTENCY_KEY_HEADER} header, not both: SDP cannot tell which one your retry keeps stable, and following the wrong one would ${consequence}.`
    );
  }
  return requestId ?? headerKey;
}

/**
 * The required form: neither source is likewise refused, because a
 * server-minted fallback is fresh per HTTP attempt and would guarantee exactly
 * the double-send it appears to guard against.
 */
function requireCallerIdempotencyKey(
  c: AppContext,
  requestId: string | undefined,
  subject: string,
  consequence: string
): string {
  const callerKey = resolveCallerIdempotencyKey(c, requestId, consequence);
  if (!callerKey) {
    throw badRequest(
      `${subject} needs an idempotency key that is stable across retries: send requestId (UUIDv4) or the ${IDEMPOTENCY_KEY_HEADER} header. Without one, a retried request would ${consequence}.`
    );
  }
  return callerKey;
}

/**
 * The key the provider dedupes a program CREATE on.
 *
 * Scoped by (organization, environment, provider) — exactly the triple whose DB
 * unique constraint used to catch a retried create before PRO-1670 made N
 * programs legal. Every SDP organization shares one provider account, so a raw
 * caller key is not tenant-unique: two organizations pasting the same
 * placeholder UUID would otherwise land on one provider request, and the second
 * would be answered with a replay of the FIRST organization's wallet — which SDP
 * would then link to the wrong tenant.
 *
 * Deliberately NOT in scope: `projectId`, because sibling projects in one
 * environment share programs and two retries arriving through different projects
 * must derive the same id (project_id is provisioning audit only). And not the
 * allocations or label — scope separates tenants, payload equality is a
 * different question, and mixing payload in would turn a retry with a corrected
 * allocation into a second program instead of a conflict.
 */
function resolveProgramCreateRequestId(
  c: AppContext,
  requestId: string | undefined,
  scope: { organizationId: string; environment: string; provider: string }
): string {
  const callerKey = requireCallerIdempotencyKey(
    c,
    requestId,
    "Creating an Earn program",
    "provision a second program the first deposit would not reach"
  );
  return deriveProviderRequestId(
    ["earn_program_create", scope.organizationId, scope.environment, scope.provider],
    callerKey
  );
}

/**
 * Provider-side name for a program with no caller-supplied label.
 *
 * The suffix comes from the DERIVED request id rather than the row id, and that
 * ordering is the whole point: the label is part of the create payload, so a
 * provider replay of a retried create must reproduce the same string. A row id
 * only exists after the insert — i.e. after the provider call — so using it
 * would make a retry's payload differ from the original and could turn a replay
 * into a payload conflict.
 */
function defaultProgramLabel(
  organizationId: string,
  environment: string,
  requestId: string
): string {
  return `sdp-earn-${organizationId}-${environment}-${requestId.slice(0, 8)}`;
}

/**
 * The program collection for the caller's (organization, environment), oldest
 * first — a stable head matters to consumers that track one program across polls
 * (migration 0056's header).
 *
 * The credential gate runs even when the caller has ZERO programs, which is a
 * deliberate behaviour change: the pre-PRO-1670 `GET /program` resolved the row
 * first, so "no program AND no credentials" answered 404. A collection cannot
 * 404 for emptiness, so without this assert a missing provider key would read as
 * "this organization has no programs" — and a dashboard would show onboarding
 * instead of its provider-unconfigured notice. Only assertable when the caller
 * named a provider; an unfiltered empty list has no provider to check.
 */
/**
 * Live reads per list page are capped: each program costs two provider calls
 * (wallet + yield), so an uncapped page of 100 would fire 200 concurrent
 * requests at Ground per read — a self-inflicted burst against a shared
 * account. Eight programs in flight keeps a default page fast (one or two
 * waves) without the burst.
 */
const LIST_LIVE_READ_CONCURRENCY = 8;

export const listEarnPrograms = async (c: AppContext) => {
  const query = parseQuery(c, earnProgramsListQuerySchema);
  const environment = resolveSdpEnvironment(c);
  const testMode = environment === "sandbox";

  if (query.provider) {
    requirePortfolioClient(query.provider);
    assertEarnProviderConfigured(c.env, query.provider, testMode);
  }

  const { rows, total } = await getEarnRepository(c).listProviderWallets({
    organizationId: getAuth(c).organizationId,
    environment,
    ...(query.provider !== undefined && { provider: query.provider }),
    ...pageWindow(query),
  });

  // Capability + credentials resolve ONCE per distinct provider, before any
  // live read. Stored provider ids are open strings (a row can outlive its
  // provider's registry entry), so a de-registered or vault-only provider fails
  // the whole list HERE with a clean 503/501 rather than mid-fan-out —
  // deliberately loud: hiding a program that holds funds is strictly worse than
  // an honest error, de-registration only ever happens after a provider is
  // drained (ADR 0002), and the caller can re-ask filtered to a live provider.
  const clients = new Map<string, EarnPortfolioWalletProvider>();
  for (const row of rows) {
    if (!clients.has(row.provider)) {
      const client = requirePortfolioClient(row.provider);
      assertEarnProviderConfigured(c.env, client.provider, testMode);
      clients.set(row.provider, client);
    }
  }

  // Each program carries a LIVE wallet snapshot; reads run in bounded waves. A
  // read that fails fails the whole list rather than silently omitting a
  // program, for the same reason as above.
  const programs: EarnProgram[] = [];
  for (let i = 0; i < rows.length; i += LIST_LIVE_READ_CONCURRENCY) {
    const wave = rows.slice(i, i + LIST_LIVE_READ_CONCURRENCY);
    programs.push(
      ...(await Promise.all(
        wave.map(async (row) => {
          const client = clients.get(row.provider) as EarnPortfolioWalletProvider;
          const { wallet, portfolioYield } = await loadProgramState(
            c,
            client,
            row.provider_wallet_ref
          );
          return mapProgram(row, wallet, portfolioYield);
        })
      ))
    );
  }

  const response: ListEarnProgramsResponse = listResponse(query, total, { programs });
  return success(c, response);
};

export const createEarnProgram = async (c: AppContext) => {
  const body = await parseBody(c, earnProgramCreateSchema);
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

  if (!auth.projectId) {
    throw internalError("Could not resolve project scope");
  }

  // Key resolution runs LAST on purpose: an unentitled caller still gets 403 and
  // a provider without the portfolio capability still gets 501, rather than a
  // generic "missing idempotency key" that hides why the call could never work.
  const requestId = resolveProgramCreateRequestId(c, body.requestId, {
    organizationId: auth.organizationId,
    environment,
    provider: client.provider,
  });

  const repo = getEarnRepository(c);
  const createdWallet = await client.createPortfolioWallet(earnRuntime(c), {
    label: body.label ?? defaultProgramLabel(auth.organizationId, environment, requestId),
    allocations: body.allocations,
    requestId,
  });

  let row: EarnProviderWalletRow | null;
  let replayed = false;
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
    if (!isPostgresUniqueViolation(err)) {
      throw err;
    }
    // A REPLAY, not a race — and the distinction is load-bearing. The provider
    // dedupes on the derived key and answers a retried create with the ORIGINAL
    // wallet ref, so a legitimate retry lands here by design; answering 409
    // would make the required idempotency key produce the very failure it exists
    // to prevent. The colliding row is this caller's own earlier program.
    row = await repo.getProviderWalletByRef({
      provider: client.provider,
      providerWalletRef: createdWallet.providerWalletRef,
    });
    if (!row || row.organization_id !== auth.organizationId || row.environment !== environment) {
      // The ref is claimed by a DIFFERENT tenant or environment. Deriving the
      // key against (organization, environment, provider) should make this
      // unreachable; if it happens the provider handed us someone else's wallet,
      // and linking it would expose their funds. Refuse rather than adopt it.
      throw conflict("Earn program wallet is already linked to another account");
    }
    replayed = true;
  }
  if (!row) {
    throw internalError("Failed to persist earn program wallet");
  }

  const { wallet, portfolioYield } = await loadProgramState(c, client, row.provider_wallet_ref);

  const response: EarnProgramResponse = { program: mapProgram(row, wallet, portfolioYield) };
  return success(c, response, replayed ? 200 : 201);
};

/**
 * Re-target this program's single vault in place (money-in: it points the
 * balance at a different strategy). Kept as a first-class verb rather than
 * forcing withdraw → wait for settlement → re-deposit for what the provider
 * supports natively.
 */
export const retargetEarnProgram = async (c: AppContext) => {
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const body = await parseBody(c, earnProgramRetargetSchema);
  const { row, client } = await requireProgramContext(c, programId);
  const auth = getAuth(c);
  const environment = resolveSdpEnvironment(c);

  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    client.provider,
    environment === "sandbox"
  );
  await assertKnownYieldSources(c, client.provider, body.allocations);

  // Same two accepted key sources as create and withdrawals — a header-keyed
  // retarget must be honored, not silently dropped, because the platform
  // middleware echoes the header on every response and a caller reads that as
  // "this key counted". Optional here (unlike create's): re-targeting moves no
  // money and re-applying the same allocations is a provider no-op, so an
  // absent key costs a duplicate provider mutation rather than a duplicate
  // wallet.
  const callerKey = resolveCallerIdempotencyKey(
    c,
    body.requestId,
    "apply the strategy change twice"
  );

  await client.updatePortfolioStrategy(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    allocations: body.allocations,
    // Derived against the program wallet like the withdrawal path, so one
    // caller key used against two programs cannot collapse into one provider
    // mutation on the shared account. Absent means the caller accepted
    // non-idempotent behaviour (see the schema).
    ...(callerKey !== undefined && {
      requestId: deriveProviderRequestId(
        ["earn_program_retarget", row.provider_wallet_ref],
        callerKey
      ),
    }),
  });

  const { wallet, portfolioYield } = await loadProgramState(c, client, row.provider_wallet_ref);

  const response: EarnProgramResponse = { program: mapProgram(row, wallet, portfolioYield) };
  return success(c, response);
};

export const getEarnProgram = async (c: AppContext) => {
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const { row, client, testMode } = await requireProgramContext(c, programId);
  assertEarnProviderConfigured(c.env, client.provider, testMode);

  const { wallet, portfolioYield } = await loadProgramState(c, client, row.provider_wallet_ref);

  const response: EarnProgramResponse = { program: mapProgram(row, wallet, portfolioYield) };
  return success(c, response);
};

export const listEarnProgramDeposits = async (c: AppContext) => {
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const query = parseQuery(c, earnProgramDepositsQuerySchema);
  const { row, client, testMode } = await requireProgramContext(c, programId);
  assertEarnProviderConfigured(c.env, client.provider, testMode);

  const response: EarnProgramDepositsResponse = await client.listPortfolioDeposits(earnRuntime(c), {
    providerWalletRef: row.provider_wallet_ref,
    ...(query.cursor !== undefined && { cursor: query.cursor }),
  });

  return success(c, response);
};

export const previewEarnProgramWithdrawal = async (c: AppContext) => {
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const body = await parseBody(c, earnProgramWithdrawalPreviewSchema);
  const { row, client, testMode } = await requireProgramContext(c, programId);

  // Money-out path: credentials only, never the entitlement gate.
  assertEarnProviderConfigured(c.env, client.provider, testMode);

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
 * Whichever way it arrives, the caller's key is DERIVED against the program
 * wallet rather than forwarded as given. Every SDP organization shares one
 * provider account, so a key is only unique to a tenant once something tenant-
 * specific is mixed in: two organizations pasting the same placeholder UUID
 * would otherwise land on one provider request, and the second would either be
 * refused or answered with a replay of the first organization's withdrawal.
 * The wallet ref carries that separation directly — one link row may claim a
 * given provider wallet platform-wide (UNIQUE (provider, provider_wallet_ref),
 * migration 0056) — and it names the thing the money leaves. Since PRO-1670 an
 * organization can hold several programs, so this scope also keeps one caller
 * key used against two of its OWN programs from collapsing into one payout.
 *
 * Deriving costs the caller nothing: the same key still reproduces the same
 * provider request on a retry, which is the only property they rely on. The
 * value SDP returns for tracking is the provider's own withdrawal ref, never
 * this id.
 */
function resolveWithdrawalRequestId(
  c: AppContext,
  requestId: string | undefined,
  providerWalletRef: string
): string {
  const callerKey = requireCallerIdempotencyKey(c, requestId, "A withdrawal", "pay out twice");
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
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const body = await parseBody(c, earnProgramWithdrawalCreateSchema);
  const { row, client, testMode } = await requireProgramContext(c, programId);

  // Money-out path: credentials only, never the entitlement gate.
  assertEarnProviderConfigured(c.env, client.provider, testMode);

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
  const { programId, withdrawalRef } = parseParams(c, earnProgramWithdrawalParamsSchema);
  const { row, client, testMode } = await requireProgramContext(c, programId);

  assertEarnProviderConfigured(c.env, client.provider, testMode);

  const repo = getEarnRepository(c);

  // BOLA guard, defense in depth: every SDP organization shares one provider
  // account, so a withdrawal ref this program does not own must 404 HERE —
  // before any provider call — regardless of how the provider scopes its own
  // lookup (Ground's read is wallet-scoped, but that is the provider's promise,
  // not ours). The ledger knows which program owns every ref it has seen; a ref
  // it has never seen (pre-ledger withdrawals) falls through to the provider's
  // wallet-scoped read, which cannot name another wallet's withdrawal.
  //
  // The comparison is the PROGRAM, not the organization. An org-only check was
  // complete while an org held one program; with several, asking program A for
  // program B's ref would pass it and then drive the provider with A's wallet
  // ref and B's withdrawal ref — a mismatch whose answer is entirely the
  // provider's to decide. wallet_id is strictly stronger and still lets an
  // unknown ref fall through.
  const ledgerRow = await repo.getProgramWithdrawalByProviderReference({
    provider: client.provider,
    providerReference: withdrawalRef,
  });
  if (ledgerRow && ledgerRow.wallet_id !== row.id) {
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
      walletId: row.id,
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
 * check, and note it resolves the program WITHOUT requirePortfolioClient —
 * because the audit trail must survive credential removal, entitlement
 * disablement, and a provider losing its registry entry entirely. Scoped to the
 * path program, like the ledger itself: every project in the environment reaches
 * the same program, so one program = one history.
 */
export const listEarnProgramWithdrawals = async (c: AppContext) => {
  const { programId } = parseParams(c, earnProgramParamsSchema);
  const query = parseQuery(c, earnProgramWithdrawalsListQuerySchema);
  const row = await requireProgram(c, programId);

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
