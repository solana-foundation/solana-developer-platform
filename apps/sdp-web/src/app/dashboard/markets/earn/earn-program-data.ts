"use client";

import {
  EARN_TERMINAL_VAULT_MOVEMENT_STATUSES,
  EARN_TERMINAL_WITHDRAWAL_STATUSES,
  EARN_VAULT_MOVEMENT_STATUSES,
  type EarnPortfolioAllocationInput,
  type EarnPortfolioToken,
  type EarnPortfolioWalletSnapshot,
  type EarnPortfolioWalletStatus,
  type EarnPortfolioWithdrawal,
  type EarnProgram,
  type EarnProgramDepositsResponse,
  type EarnProgramResponse,
  type EarnProgramWithdrawalPreviewResponse,
  type EarnProgramWithdrawalRecord,
  type EarnProgramWithdrawalResponse,
  type EarnStrategy,
  type EarnTerminalVaultMovementStatus,
  type EarnVaultDeposit,
  type EarnVaultDepositRecord,
  type EarnVaultDepositRequest,
  type EarnVaultMovementStatus,
  type EarnVaultPosition,
  type EarnVaultPositionsPage,
  type ListEarnProgramsResponse,
  type ListEarnProgramWithdrawalsResponse,
  type ListEarnStrategiesResponse,
  SOLANA_CLUSTERS,
} from "@sdp/types";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import {
  EARN_PROGRAM_CREATE_PROVIDER,
  EARN_PROGRAM_CREATION_ENABLED,
  isEarnVaultDepositAvailable,
  SURFACED_CUSTODIAL_EARN_PROVIDERS,
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
} from "./earn-surfacing";

export type {
  EarnProgram,
  EarnProgramDepositsResponse,
  EarnProgramResponse,
  EarnProgramWithdrawalPreviewResponse,
  EarnProgramWithdrawalRecord,
  EarnProgramWithdrawalResponse,
  EarnVaultDeposit,
  EarnVaultDepositRecord,
  EarnVaultDepositRequest,
  EarnVaultPosition,
  EarnVaultPositionsPage,
  ListEarnProgramsResponse,
  ListEarnProgramWithdrawalsResponse,
} from "@sdp/types";

/**
 * Live Earn data access for the dashboard, over the /api/dashboard/markets/earn
 * BFF proxies.
 *
 * **No provider id is spelled in this file.** Which providers are offered, and
 * which of those hold money through a program, are both derived from the single
 * declaration in `@sdp/types` (`EARN_PROVIDER_SURFACING`) via `./earn-surfacing`.
 * Reads are provider-agnostic on purpose — the Positions surface must show every
 * program the organization holds, including one whose provider is no longer
 * offered.
 *
 * The API returns a LIST of programs since PRO-1670 — an organization may hold
 * several, each pinned to one vault — and every surface here is program-scoped:
 * deposits, previews, withdrawals and the outcome watcher all take a programId.
 * The list is ordered oldest-first by the API, so the cached collection keeps
 * a stable head. The overview sorts a copy newest-first only at its card-render
 * boundary, after every page has loaded.
 */
/**
 * These surfacing values live in `./earn-surfacing` (no `"use client"`) and
 * are re-exported here so client callers keep one import site. They must NOT be
 * declared in this file: a Server Component importing a value from a client
 * module gets a client-reference proxy rather than the value, which silently
 * broke the deposit route's server-side guard. See that file's header.
 */
export {
  EARN_PROGRAM_CREATE_PROVIDER,
  EARN_PROGRAM_CREATION_ENABLED,
  isEarnVaultDepositAvailable,
  SURFACED_CUSTODIAL_EARN_PROVIDERS,
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
};

/**
 * Program read outcome. `ready` carries the list and MAY be empty — an empty
 * array is how "this organization holds no programs" arrives, and it drives the
 * onboarding hero. There is deliberately no separate `none` state: with a
 * collection the emptiness is already in the data, and a second way to say it
 * is a second thing that can drift.
 *
 * `unconfigured` (upstream 503, provider credentials missing) renders a quiet
 * notice instead of crashing the overview.
 */
export type EarnProgramsState =
  | { kind: "ready"; programs: readonly EarnProgram[] }
  | { kind: "unconfigured" };

/** True once the read resolved AND the organization holds at least one program. */
export function hasPrograms(state: EarnProgramsState | undefined): boolean {
  return state?.kind === "ready" && state.programs.length > 0;
}

export function findProgram(
  state: EarnProgramsState | undefined,
  programId: string | undefined
): EarnProgram | undefined {
  if (!programId || state?.kind !== "ready") return undefined;
  return state.programs.find((program) => program.id === programId);
}

async function requestJson<T>(path: string): Promise<{ status: number; body: T | undefined }> {
  const response = await fetch(path);
  let body: T | undefined;
  try {
    body = (await response.json()) as T;
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return `Request failed (${status})`;
}

/** BFF path for one program's sub-resources — the one place it is spelled. */
function programPath(programId: string, suffix = ""): string {
  return `/api/dashboard/markets/earn/programs/${encodeURIComponent(programId)}${suffix}`;
}

const PROGRAMS_PAGE_SIZE = 100;

/**
 * Hard stop on the paging loop, same reason as STRATEGY_PAGE_LIMIT: a bad
 * `total` must never spin forever. 20 pages × 100 = 2,000 programs, far past
 * anything an organization can plausibly hold.
 */
const PROGRAMS_PAGE_LIMIT = 20;

/**
 * There is deliberately NO 404 branch. A collection cannot 404 for emptiness,
 * so "this organization has no programs" is a 200 with an empty array — and if
 * a 404 were still mapped to `none`, a retired path, a typo'd proxy path, or a
 * missing Next route (which answers with HTML, not our envelope) would all read
 * as "no programs" and show onboarding to a customer with funds deployed.
 * Letting those throw surfaces the retry UI, which is the honest outcome.
 *
 * PAGES the collection to the end, exactly like fetchEarnStrategies and for the
 * same reason: a single request silently drops everything past the API's page
 * window, and a hidden program is hidden MONEY — the totals under-report, its
 * card never renders, and its deep links stop resolving.
 */
export async function fetchEarnProgramsState(): Promise<EarnProgramsState> {
  const programs: EarnProgram[] = [];

  for (let page = 1; page <= PROGRAMS_PAGE_LIMIT; page += 1) {
    const { status, body } = await requestJson<{ data: ListEarnProgramsResponse }>(
      // UNFILTERED by provider, deliberately. Positions must show every program
      // the organization holds — a filter pinned to one provider hides money,
      // which is the worst failure this surface has. It also has to keep working
      // for a provider that is no longer offered (ADR 0002 exit safety), and a
      // surfacing-derived filter would do exactly the opposite.
      //
      // The cost is narrow: the API can only run its credential check when the
      // caller names a provider, so "zero programs AND no credentials" now reads
      // as an empty list rather than `unconfigured`. That is the one case with no
      // money at stake. Whenever the org DOES hold a program whose provider is
      // un-credentialed, the API still 503s the whole list (it gates per distinct
      // provider among the rows), so the notice still appears when it matters.
      `/api/dashboard/markets/earn/programs?page=${page}&pageSize=${PROGRAMS_PAGE_SIZE}`
    );
    // Checked before the range test: a 503 carries no usable body and would
    // otherwise fall into the throw.
    if (status === 503) return { kind: "unconfigured" };
    if (status < 200 || status >= 300 || !body) {
      throw new Error(errorMessage(body, status));
    }

    programs.push(...body.data.programs);
    if (programs.length >= body.data.total) {
      return { kind: "ready", programs };
    }
    if (body.data.programs.length < PROGRAMS_PAGE_SIZE) {
      throw new Error("Earn programs pagination ended before the reported total");
    }
  }

  // A partial portfolio is worse than an error because it can hide money.
  throw new Error("Earn programs pagination exceeded its safety limit");
}

/**
 * Poll cadence per wallet status — a property of the WALLET, never of the
 * caller. Every surface reads the same live provider snapshot, and none of
 * them wants a state that stops converging: `creating` blocks the funding step
 * on a deposit address that does not exist yet, and `busy` means the provider
 * is mid-withdrawal or mid-rebalance, so the figures on screen are already
 * out of date. A settled `ready` wallet still carries provider-live balances,
 * so it refreshes at a quieter cadence instead of freezing at page load.
 *
 * Ground is hit live on every program read, so `busy` is deliberately slower
 * than `creating`: against a ~40s observed settle the reader loses nothing
 * perceptible and the provider takes a quarter of the requests.
 */
const WALLET_POLL_MS: Partial<Record<EarnPortfolioWalletStatus, number>> = {
  creating: 4_000,
  busy: 10_000,
  ready: 30_000,
};

/**
 * Poll cadence for the program read; 0 means stop. Exported so the rule is
 * assertable — a browser cannot prove it, because SWR suspends the interval
 * whenever the tab is hidden.
 *
 * One read serves every program, so the cadence is the FASTEST any single
 * program asks for (a `creating` program among settled ones must still converge
 * on its deposit address, and a `busy` one must not sit frozen while money
 * moves). Taking the first program's cadence, or the slowest, would strand
 * exactly the program that is mid-operation.
 */
export function earnProgramsRefreshInterval(state: EarnProgramsState | undefined): number {
  if (state?.kind !== "ready") return 0;
  return state.programs.reduce((fastest, program) => {
    const cadence = WALLET_POLL_MS[program.wallet.status] ?? 0;
    if (cadence === 0) return fastest;
    return fastest === 0 ? cadence : Math.min(fastest, cadence);
  }, 0);
}

/**
 * Dedupe window for the program read. MUST stay below every cadence in
 * `WALLET_POLL_MS`: the dashboard-wide default (`DASHBOARD_SWR_CONFIG`) is
 * 10s, which is the busy cadence itself, and a poll landing inside its own
 * dedupe window is dropped — freezing the status exactly while it moves.
 */
export const EARN_PROGRAM_DEDUPING_MS = 2_000;

/**
 * Announce a provider operation FINISHING, once, from observed truth.
 *
 * The provider is the only authority on whether the money moved, so this
 * watches the polled wallet for a `busy → settled` transition rather than
 * reacting to what the user submitted: a withdrawal that fails still tells the
 * truth, and a rebalance the provider started by itself is announced the same
 * way. What completed is named from the activity observed BEFORE the
 * transition, since the provider drops it once the wallet settles.
 *
 * Never fires on first observation — a program that is already busy when the
 * page opens is a state, not an event — and only from the ONE caller that owns
 * the surface, since the hook it observes runs in several components.
 *
 * Snapshots are remembered PER PROGRAM ID, never as one previous wallet. With
 * several programs, a single remembered snapshot would compare whichever
 * program happened to be looked at last against a different program this pass —
 * reading a busy→settled transition that never happened and announcing money
 * that never moved.
 */
export function useEarnWalletActivityToasts(state: EarnProgramsState | undefined) {
  const t = useTranslations();
  const previous = useRef<Map<string, EarnPortfolioWalletSnapshot>>(new Map());

  useEffect(() => {
    if (state?.kind !== "ready") {
      // An unconfigured or errored interlude breaks the observation chain: by
      // the time the read recovers, a program that was busy may have settled
      // minutes ago, and pairing the stale snapshot with the fresh read would
      // announce a completion nobody watched happen. Forget everything and
      // treat recovery like a first mount, which never announces.
      previous.current.clear();
      return;
    }

    const seen = new Set<string>();
    for (const program of state.programs) {
      seen.add(program.id);
      const wallet = program.wallet;
      const before = previous.current.get(program.id);
      previous.current.set(program.id, wallet);

      // Nothing to compare against yet, or the wallet was never busy, or it is
      // still busy — no completion has been observed.
      if (before?.status !== "busy" || wallet.status === "busy") {
        continue;
      }
      if (wallet.status === "failed") {
        toast.error(t("DashboardEarn.overview.activityFailed"));
        continue;
      }
      // A withdrawal is NOT announced here. This transition only says the
      // provider stopped working — a failed or partial payout leaves the wallet
      // exactly as idle as a settled one — so the outcome comes from
      // `useEarnWithdrawalOutcomeToast`, which reads the withdrawal itself.
      if (before.activity === "withdrawing") {
        continue;
      }
      announceCompletion(t, before.activity);
    }

    // Drop programs that vanished, so a re-created id cannot inherit a stale
    // snapshot and fire a transition on first sight.
    for (const id of previous.current.keys()) {
      if (!seen.has(id)) previous.current.delete(id);
    }
  }, [state, t]);
}

function announceCompletion(
  t: ReturnType<typeof useTranslations>,
  activity: EarnPortfolioWalletSnapshot["activity"]
) {
  toast.success(
    t(
      activity === "rebalancing"
        ? "DashboardEarn.overview.activityRebalanceComplete"
        : // A busy state this build does not recognize still completed; say
          // so without claiming which operation it was, and without
          // claiming anything about money.
          "DashboardEarn.overview.activityComplete"
    )
  );
}

export function useEarnPrograms() {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-programs",
    () => fetchEarnProgramsState(),
    {
      refreshInterval: earnProgramsRefreshInterval,
      dedupingInterval: EARN_PROGRAM_DEDUPING_MS,
    }
  );
  return { state: data, error, isLoading, refresh: () => void mutate() };
}

export interface EarnProgramWriteInput {
  /** Weights per token group, keyed to provider yield-source ids. */
  allocations: EarnPortfolioAllocationInput;
  label?: string;
  /**
   * Client-minted UUIDv4 so a retried confirm can neither provision a second
   * program nor apply the same strategy change twice. Must be re-minted whenever
   * `allocations` changes — the provider conflicts on a reused key with a
   * different payload.
   *
   * REQUIRED on create since PRO-1670: with several programs legal, nothing
   * downstream can tell a retry from a genuine second program, so the API
   * refuses a create that carries no key.
   */
  requestId: string;
}

/** Provision a new program. 201 on create, 200 when the provider replayed. */
export function createEarnProgram(
  input: EarnProgramWriteInput
): Promise<DashboardFetchResult<{ data: EarnProgramResponse }>> {
  if (EARN_PROGRAM_CREATE_PROVIDER === undefined) {
    // Unreachable through the UI — every create affordance is gated on
    // EARN_PROGRAM_CREATION_ENABLED — so this is a programming error, not a
    // state to render. Failing loudly beats POSTing `provider: undefined` and
    // reading the API's schema 400 as if the input were at fault.
    return Promise.reject(new Error("No surfaced Earn provider offers programs"));
  }
  return dashboardFetch("/api/dashboard/markets/earn/programs", {
    method: "POST",
    body: { provider: EARN_PROGRAM_CREATE_PROVIDER, ...input },
  });
}

/** Re-target an existing program's single vault in place. */
export function retargetEarnProgram(
  programId: string,
  input: EarnProgramWriteInput
): Promise<DashboardFetchResult<{ data: EarnProgramResponse }>> {
  return dashboardFetch(programPath(programId), { method: "PUT", body: input });
}

export async function fetchEarnProgramDeposits(
  programId: string
): Promise<EarnProgramDepositsResponse> {
  const { status, body } = await requestJson<{ data: EarnProgramDepositsResponse }>(
    programPath(programId, "/deposits")
  );
  // No 404 branch, same reasoning as the programs read: the id always comes
  // from a program resolved through the live list in this org+environment, so a
  // 404 here is a broken proxy path or a scoping regression — mapping it to an
  // empty feed would render a routing bug as "no deposits yet" on a funded
  // program. The card's error state is the honest rendering.
  if (status < 200 || status >= 300 || !body) {
    throw new Error(errorMessage(body, status));
  }
  return body.data;
}

/** Passing no programId issues no request — the honest form of "not ready yet". */
export function useEarnProgramDeposits(programId: string | undefined) {
  const { data, error, isLoading } = useSWR(
    programId ? ["dashboard-earn-program-deposits", programId] : null,
    () => fetchEarnProgramDeposits(programId as string),
    // Deposits land on-chain outside the dashboard, so keep the feed fresh.
    { refreshInterval: 15_000 }
  );
  return { page: data, error, isLoading };
}

/** The API caps pageSize at 100, so a full catalogue needs paging. */
const STRATEGY_PAGE_SIZE = 100;

/**
 * Hard stop on the paging loop. The catalogue is a synced provider list in the
 * low tens, so this only exists so a bad `total` can never spin forever.
 */
const STRATEGY_PAGE_LIMIT = 20;

/**
 * The whole active catalogue. The list endpoint has no provider filter and
 * offers no sort control, so callers filter and order client-side — which only
 * works if every page is actually fetched. Requesting one page of 100 silently
 * dropped everything past it once a second provider synced.
 */
export async function fetchEarnStrategies(): Promise<EarnStrategy[]> {
  const strategies: EarnStrategy[] = [];

  for (let page = 1; page <= STRATEGY_PAGE_LIMIT; page += 1) {
    const { status, body } = await requestJson<{ data: ListEarnStrategiesResponse }>(
      `/api/dashboard/markets/earn/strategies?page=${page}&pageSize=${STRATEGY_PAGE_SIZE}`
    );
    if (status < 200 || status >= 300 || !body) {
      throw new Error(errorMessage(body, status));
    }

    strategies.push(...body.data.strategies);
    if (strategies.length >= body.data.total) {
      return strategies;
    }
    if (body.data.strategies.length < STRATEGY_PAGE_SIZE) {
      throw new Error("Earn strategies pagination ended before the reported total");
    }
  }

  throw new Error("Earn strategies pagination exceeded its safety limit");
}

export function useEarnStrategies() {
  const { data, error, isLoading, mutate } = useSWR("dashboard-earn-strategies", () =>
    fetchEarnStrategies()
  );
  return { strategies: data, error, isLoading, refresh: () => void mutate() };
}

const VAULT_POSITIONS_PAGE_SIZE = 100;
const VAULT_POSITIONS_PAGE_LIMIT = 20;

/**
 * Reads every vault position held by the selected project. The API uses an
 * opaque keyset cursor and hydrates balances live from chain, so cursor
 * progression — not row count — decides when the read is complete.
 */
export async function fetchEarnVaultPositions(): Promise<EarnVaultPosition[]> {
  const positions: EarnVaultPosition[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  for (let page = 1; page <= VAULT_POSITIONS_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(VAULT_POSITIONS_PAGE_SIZE) });
    if (before) query.set("before", before);

    const { status, body } = await requestJson<{ data: EarnVaultPositionsPage }>(
      `/api/dashboard/markets/earn/vault-positions?${query}`
    );
    if (status < 200 || status >= 300 || !body) {
      throw new Error(errorMessage(body, status));
    }

    positions.push(...body.data.positions);
    if (!body.data.hasMore) return positions;

    const nextCursor = body.data.nextCursor;
    if (!nextCursor || nextCursor === before || seenCursors.has(nextCursor)) {
      throw new Error("Vault positions pagination did not advance");
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  throw new Error("Vault positions pagination exceeded its safety limit");
}

/** Live position values refresh while the surface is mounted. */
export function useEarnVaultPositions() {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-vault-positions",
    () => fetchEarnVaultPositions(),
    { refreshInterval: 15_000 }
  );
  return { positions: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * The two envelopes a 2xx vault deposit can answer with, parsed at the
 * boundary rather than narrowed by hand.
 *
 * `dashboardFetch` has already rejected every non-2xx status, so only these
 * two shapes are reachable: the created movement, or the policy hold that the
 * API reports as a `202` carrying an error-shaped body. Parsing both means the
 * deposit RECORD is checked too — the previous `as unknown as EarnVaultDeposit`
 * asserted a movement id and signature that were never looked at.
 *
 * `z.union` rather than `z.discriminatedUnion`: the two envelopes share no
 * common key, so there is no discriminator to switch on — the tag is minted by
 * the transforms below, which is what makes the OUTCOME a discriminated union
 * for every caller.
 *
 * The record schema is annotated `z.ZodType<EarnVaultDeposit>` rather than left
 * to inference, so a field added or renamed in `@sdp/types` fails typecheck
 * here instead of being silently stripped from a parsed deposit.
 */
const earnVaultDepositSchema: z.ZodType<EarnVaultDeposit> = z.object({
  positionId: z.string(),
  movementId: z.string(),
  status: z.enum(EARN_VAULT_MOVEMENT_STATUSES),
  signature: z.string(),
  failureReason: z.string().nullable(),
  replayed: z.boolean(),
  strategy: z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    providerReference: z.string(),
    hostCluster: z.enum(SOLANA_CLUSTERS),
  }),
});

const earnVaultDepositOutcomeSchema = z.union([
  z
    .object({ data: earnVaultDepositSchema })
    .transform(({ data }) => ({ kind: "submitted" as const, deposit: data })),
  z
    .object({
      error: z.object({
        code: z.literal("SIGNING_PENDING"),
        message: z.string(),
        details: z
          .object({
            approvalRequestId: z.string().optional(),
            walletOperationId: z.string().optional(),
          })
          .optional(),
      }),
    })
    .transform(({ error }) => ({
      kind: "approval_pending" as const,
      message: error.message,
      approvalRequestId: error.details?.approvalRequestId,
      walletOperationId: error.details?.walletOperationId,
    })),
]);

export type EarnVaultDepositOutcome = z.infer<typeof earnVaultDepositOutcomeSchema>;

/**
 * Deposits from an SDP custody wallet into a non-custodial vault. The caller's
 * idempotency key is transport metadata and is never copied into the JSON body.
 */
export async function createEarnVaultDeposit(
  input: EarnVaultDepositRequest,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<DashboardFetchResult<EarnVaultDepositOutcome>> {
  // Rebuild the body field-by-field so even an untyped caller cannot smuggle
  // requestId (the legacy custodial-program contract) or arbitrary fields into
  // this value-moving request.
  const body: EarnVaultDepositRequest = {
    strategyId: input.strategyId,
    custodyWalletId: input.custodyWalletId,
    amount: input.amount,
    ...(input.minSharesOut === undefined ? {} : { minSharesOut: input.minSharesOut }),
  };
  const result = await dashboardFetch<unknown>("/api/dashboard/markets/earn/vault-deposits", {
    method: "POST",
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body,
    signal,
  });

  if (!result.ok) return result;

  const invalid = {
    ok: false,
    error: "Invalid vault deposit response",
    status: result.status,
    body: result.data,
  } as const;

  const parsed = earnVaultDepositOutcomeSchema.safeParse(result.data);
  if (!parsed.success) return invalid;
  // An approval hold is specifically the 202 contract. A 200 or 201 carrying it
  // would mean the API reported a deposit as both created and held, and this
  // must not resolve that contradiction in the customer's favour.
  if (parsed.data.kind === "approval_pending" && result.status !== 202) return invalid;

  return { ok: true, status: result.status, data: parsed.data };
}

/**
 * The durable record of one recorded deposit, read back by movement id.
 *
 * Annotated `z.ZodType<EarnVaultDepositRecord>` for the same reason the create
 * envelope is: a field added or renamed in `@sdp/types` must fail typecheck
 * here rather than be silently stripped from a parsed deposit.
 */
const earnVaultDepositRecordSchema: z.ZodType<EarnVaultDepositRecord> = z.object({
  movementId: z.string(),
  positionId: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  status: z.enum(EARN_VAULT_MOVEMENT_STATUSES),
  signature: z.string(),
  amount: z.string(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
});

const earnVaultDepositResponseSchema = z.object({
  data: z.object({ deposit: earnVaultDepositRecordSchema }),
});

/**
 * Read one recorded vault deposit. Returns `undefined` for every unusable
 * answer — a transport failure, a 404, or an envelope that does not parse.
 *
 * `undefined` is deliberately NOT terminal: the caller keeps polling. A read
 * that failed says nothing about whether the deposit landed, and treating it
 * as an outcome would announce a settlement the API never reported.
 */
export async function fetchEarnVaultDeposit(
  movementId: string
): Promise<EarnVaultDepositRecord | undefined> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-deposits/${encodeURIComponent(movementId)}`
  );
  if (!result.ok) return undefined;
  const parsed = earnVaultDepositResponseSchema.safeParse(result.data);
  return parsed.success ? parsed.data.data.deposit : undefined;
}

const earnVaultDepositsPageSchema = z.object({
  data: z.object({
    deposits: z.array(earnVaultDepositRecordSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

const VAULT_DEPOSITS_PAGE_SIZE = 100;

/**
 * Hard stop on the paging loop, same reason as the other readers: a server that
 * never stops advancing its cursor must not spin forever. 20 pages x 100 is far
 * past any plausible number of SIMULTANEOUSLY in-flight deposits.
 */
const VAULT_DEPOSITS_PAGE_LIMIT = 20;

/**
 * This workspace's recorded deposits, newest first. The API derives the
 * organization and project itself from the session, so this takes no scope
 * argument — passing one would be a second, drifting copy of the boundary.
 *
 * PAGES TO THE END and fails loudly rather than truncating, like
 * `fetchEarnVaultPositions` and `fetchEarnStrategies`. A silently short page
 * here is a deposit that stops being tracked: its terminal outcome is never
 * announced and the balances it changed are never refreshed.
 *
 * `settled: false` is what makes that affordable. Asking the server for only
 * the movements that can still change keeps the result small by construction —
 * the reconciliation sweep drives every row terminal within about ninety
 * seconds — instead of paging an unbounded history to filter it locally. A
 * workspace busy enough to push an in-flight deposit past the first page is
 * exactly the case a single request got wrong.
 */
export async function fetchEarnVaultDeposits(
  options: { settled?: boolean } = {}
): Promise<EarnVaultDepositRecord[]> {
  const deposits: EarnVaultDepositRecord[] = [];
  const seenCursors = new Set<string>();
  let before: string | null = null;

  for (let page = 0; page < VAULT_DEPOSITS_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(VAULT_DEPOSITS_PAGE_SIZE) });
    if (options.settled !== undefined) query.set("settled", String(options.settled));
    if (before) query.set("before", before);

    const result = await dashboardFetch<unknown>(
      `/api/dashboard/markets/earn/vault-deposits?${query.toString()}`
    );
    if (!result.ok) throw new Error(result.error);
    const parsed = earnVaultDepositsPageSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Invalid vault deposits response");

    const body = parsed.data.data;
    deposits.push(...body.deposits);
    if (!body.hasMore) return deposits;

    const nextCursor = body.nextCursor;
    if (!nextCursor || nextCursor === before || seenCursors.has(nextCursor)) {
      throw new Error("Vault deposits pagination did not advance");
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  throw new Error("Vault deposits pagination exceeded its safety limit");
}

/**
 * What the store could establish about a key: the deposit it produced, that it
 * produced none, or that the question could not be answered right now.
 *
 * Three outcomes, not two. Collapsing `unavailable` into `absent` is what makes
 * a failed read look like "no deposit exists", and a caller deciding whether a
 * key is spent would then reuse a spent one.
 */
export type EarnVaultDepositByRequestId =
  | { kind: "found"; deposit: EarnVaultDepositRecord }
  | { kind: "absent" }
  | { kind: "unavailable" };

/**
 * Resolve the deposit a given idempotency key produced, if one exists yet.
 *
 * The approval path needs this: a policy hold creates no movement, so the only
 * handle the client keeps is the key it minted, and "has the write behind this
 * key happened?" is a question only the server can answer.
 *
 * Note there is no 404 to interpret — the list answers 200 with an empty page
 * for a key it has never seen — so a non-ok result really does mean the read
 * failed rather than the deposit being absent.
 */
export async function fetchEarnVaultDepositByRequestId(
  requestId: string
): Promise<EarnVaultDepositByRequestId> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-deposits?requestId=${encodeURIComponent(requestId)}`
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = earnVaultDepositsPageSchema.safeParse(result.data);
  if (!parsed.success) return { kind: "unavailable" };
  const deposit = parsed.data.data.deposits[0];
  return deposit ? { kind: "found", deposit } : { kind: "absent" };
}

/**
 * The DISCOVERY tier for in-flight deposits, mirroring `useEarnProgramWithdrawals`.
 *
 * Thirty seconds, and deliberately slower than the per-deposit tracker's five:
 * this list only decides WHICH deposits are worth watching, and each watch then
 * runs its own fast poll. It is also how a deposit signed before a reload — or
 * in another tab, or unblocked by a policy approval minutes later — becomes
 * visible again, which is the whole reason it is a server read rather than
 * browser state.
 */
export function useEarnVaultDeposits() {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-vault-deposits-in-flight",
    () => fetchEarnVaultDeposits({ settled: false }),
    { refreshInterval: 30_000 }
  );
  return { deposits: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * Statuses a vault movement never moves on from — the shared canonical set,
 * one declaration in @sdp/types.
 *
 * Note what is NOT here: `pending`. It reads like a failure and is not one —
 * SDP signed and recorded the transaction but could not establish that it
 * reached the network, so the reconciliation sweep is still working on it.
 * Announcing an outcome there would be the exact lie this watch exists to
 * avoid, in the one case where the customer's money is genuinely in the air.
 */
const SETTLED_VAULT_MOVEMENT_STATUSES: ReadonlySet<EarnVaultMovementStatus> = new Set(
  EARN_TERMINAL_VAULT_MOVEMENT_STATUSES
);

/**
 * Whether a recorded deposit can still change, and therefore is worth watching.
 *
 * Exported so the recovery filter and the poll's stop condition read the SAME
 * rule. `pending` counts as in flight: it means SDP could not establish that
 * the transaction reached the network, not that it failed.
 */
export function isEarnVaultDepositInFlight(deposit: EarnVaultDepositRecord): boolean {
  return !SETTLED_VAULT_MOVEMENT_STATUSES.has(deposit.status);
}

const VAULT_DEPOSIT_OUTCOME_KEYS = {
  confirmed: "DashboardEarn.deposit.vaultOutcomeConfirmed",
  failed: "DashboardEarn.deposit.vaultOutcomeFailed",
} as const satisfies Record<EarnTerminalVaultMovementStatus, MessageKey>;

/**
 * Announce how a submitted vault deposit actually ended, and only once it has
 * ended.
 *
 * `POST /vault-deposits` records the signed transaction BEFORE broadcasting it,
 * so its response is a receipt for a signature, not for a holding. Between that
 * receipt and the chain there are three real outcomes — landed, rejected, or
 * the blockhash expired without it ever landing — and the every-minute
 * reconciliation sweep is the only thing that can tell them apart. This watches
 * the movement until it says one of them.
 *
 * Polls until the status is terminal (`confirmed | failed`), then announces
 * once. Passing `undefined` — nothing deposited this session — does nothing and
 * issues no requests.
 *
 * `onSettled` fires once, right after the announcement, so the caller can
 * refresh the balances the deposit changed and retire the watch: a settled
 * watcher has nothing left to do, and keeping it mounted would accumulate dead
 * SWR subscriptions over a long session.
 */
export function useEarnVaultDepositOutcomeToast(
  movementId: string | undefined,
  onSettled?: () => void
): void {
  const t = useTranslations();
  const announced = useRef<string | undefined>(undefined);
  // A ref so a re-created callback identity can never re-trigger the effect —
  // the announcement (and therefore the retire signal) must fire exactly once.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const { data } = useSWR(
    movementId ? (["dashboard-earn-vault-deposit", movementId] as const) : null,
    // The id comes from the KEY, which only exists when it is defined — no cast,
    // and no second place that has to stay in sync with the null guard.
    ([, watchedId]) => fetchEarnVaultDeposit(watchedId),
    {
      refreshInterval: (deposit) =>
        deposit && SETTLED_VAULT_MOVEMENT_STATUSES.has(deposit.status) ? 0 : 5_000,
      dedupingInterval: EARN_PROGRAM_DEDUPING_MS,
    }
  );

  useEffect(() => {
    if (!data || !SETTLED_VAULT_MOVEMENT_STATUSES.has(data.status)) return;
    // Once per movement: polling keeps returning the terminal read.
    if (announced.current === data.movementId) return;
    announced.current = data.movementId;

    if (data.status === "confirmed") {
      toast.success(t(VAULT_DEPOSIT_OUTCOME_KEYS.confirmed));
    } else {
      // The provider's own reason when there is one — "insufficient funds" is
      // actionable and "the deposit failed" is not.
      toast.error(data.failureReason || t(VAULT_DEPOSIT_OUTCOME_KEYS.failed));
    }
    onSettledRef.current?.();
  }, [data, t]);
}

export interface EarnWithdrawalPreviewInput {
  /**
   * Omit for the LIQUIDITY read — "what can this lane pay right now?" — which
   * is what the withdraw modal asks on open, before the reader types anything
   * (PRO-1675). Present, the preview also validates that exact amount and
   * returns its fee and post-withdrawal total.
   */
  amountUsd?: string;
  token: EarnPortfolioToken;
}

export function previewEarnWithdrawal(
  programId: string,
  input: EarnWithdrawalPreviewInput,
  signal?: AbortSignal
): Promise<DashboardFetchResult<{ data: EarnProgramWithdrawalPreviewResponse }>> {
  return dashboardFetch(programPath(programId, "/withdrawal-preview"), {
    method: "POST",
    body: input,
    signal,
  });
}

export interface EarnWithdrawalCreateInput extends EarnWithdrawalPreviewInput {
  /** Client-minted UUIDv4 so a retried confirm can never double-withdraw. */
  requestId: string;
  destinationAddress: string;
}

export function createEarnWithdrawal(
  programId: string,
  input: EarnWithdrawalCreateInput
): Promise<DashboardFetchResult<{ data: EarnProgramWithdrawalResponse }>> {
  return dashboardFetch(programPath(programId, "/withdrawals"), { method: "POST", body: input });
}

export function fetchEarnWithdrawal(
  programId: string,
  withdrawalRef: string
): Promise<DashboardFetchResult<{ data: EarnProgramWithdrawalResponse }>> {
  return dashboardFetch(
    programPath(programId, `/withdrawals/${encodeURIComponent(withdrawalRef)}`)
  );
}

const PROGRAM_WITHDRAWALS_PAGE_SIZE = 100;
const PROGRAM_WITHDRAWALS_PAGE_LIMIT = 20;

/**
 * Read a program's complete durable withdrawal ledger. Returning a partial
 * history would make an in-flight payout disappear after a reload, so every
 * inconsistent or over-limit pagination outcome throws instead of returning
 * the prefix collected so far.
 */
export async function fetchEarnProgramWithdrawals(
  programId: string
): Promise<EarnProgramWithdrawalRecord[]> {
  const withdrawals: EarnProgramWithdrawalRecord[] = [];

  for (let page = 1; page <= PROGRAM_WITHDRAWALS_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(PROGRAM_WITHDRAWALS_PAGE_SIZE),
    });
    const { status, body } = await requestJson<{ data: ListEarnProgramWithdrawalsResponse }>(
      `${programPath(programId, "/withdrawals")}?${query}`
    );
    if (status < 200 || status >= 300 || !body) {
      throw new Error(errorMessage(body, status));
    }

    const ledgerPage = body.data;
    if (ledgerPage.page !== page || ledgerPage.pageSize !== PROGRAM_WITHDRAWALS_PAGE_SIZE) {
      throw new Error("Earn withdrawal ledger pagination did not match the requested page");
    }
    if (!Number.isSafeInteger(ledgerPage.total) || ledgerPage.total < 0) {
      throw new Error("Earn withdrawal ledger reported an invalid total");
    }

    withdrawals.push(...ledgerPage.withdrawals);
    if (withdrawals.length === ledgerPage.total) return withdrawals;
    if (withdrawals.length > ledgerPage.total) {
      throw new Error("Earn withdrawal ledger returned more rows than its reported total");
    }
    if (ledgerPage.withdrawals.length < PROGRAM_WITHDRAWALS_PAGE_SIZE) {
      throw new Error("Earn withdrawal ledger pagination ended before the reported total");
    }
  }

  throw new Error("Earn withdrawal ledger pagination exceeded its safety limit");
}

/** Passing no program id issues no ledger request. */
export function useEarnProgramWithdrawals(programId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR(
    programId ? ["dashboard-earn-program-withdrawals", programId] : null,
    () => fetchEarnProgramWithdrawals(programId as string),
    // Detect withdrawals created from another session while this dashboard is
    // open; the list is a cheap local-DB read and live outcome polling begins
    // only for provider-accepted nonterminal rows.
    { refreshInterval: 30_000 }
  );
  return { withdrawals: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * Statuses a withdrawal never moves on from — the shared canonical set (also
 * the API ledger's terminal set, one declaration in @sdp/types). Note what is
 * NOT here: `pending_approval` is a WAIT, not an outcome — the payout is
 * parked on a customer signature and still resolves later — so watching
 * continues.
 */
const SETTLED_WITHDRAWAL_STATUSES: ReadonlySet<EarnPortfolioWithdrawal["status"]> = new Set(
  EARN_TERMINAL_WITHDRAWAL_STATUSES
);

const WITHDRAWAL_OUTCOME_KEYS = {
  completed: "DashboardEarn.overview.withdrawalCompleted",
  partially_completed: "DashboardEarn.overview.withdrawalPartiallyCompleted",
  failed: "DashboardEarn.overview.withdrawalFailed",
  cancelled: "DashboardEarn.overview.withdrawalCancelled",
  pending_approval: "DashboardEarn.overview.withdrawalPendingApproval",
  processing: "DashboardEarn.overview.withdrawalProcessing",
} as const satisfies Record<EarnPortfolioWithdrawal["status"], MessageKey>;

/**
 * Announce how a submitted withdrawal actually ended, by watching the
 * WITHDRAWAL rather than the wallet.
 *
 * The wallet only models whether an operation is in flight, so its return to
 * `ready` says the provider stopped working — not that the money arrived. A
 * failed, cancelled or partially-completed payout leaves the wallet just as
 * idle as a successful one, so a settlement claim sourced from that transition
 * would be wrong precisely when it matters most. The withdrawal carries its own
 * status, and that is the only thing that knows.
 *
 * Polls until the status is terminal (`pending_approval` keeps waiting — it
 * resolves once someone signs), then announces once. Passing `undefined` for
 * either argument — no withdrawal submitted this session, or the program read
 * has not resolved — does nothing and issues no requests.
 *
 * `onSettled` fires once, right after the announcement, so the caller can
 * retire the watch: a settled watcher has nothing left to do, and keeping it
 * mounted would accumulate dead SWR subscriptions over a long session.
 */
export function useEarnWithdrawalOutcomeToast(
  programId: string | undefined,
  withdrawalRef: string | undefined,
  onSettled?: () => void
): void {
  const t = useTranslations();
  const announced = useRef<string | undefined>(undefined);
  // A ref so a re-created callback identity can never re-trigger the effect —
  // the announcement (and therefore the retire signal) must fire exactly once.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const { data } = useSWR(
    programId && withdrawalRef ? ["dashboard-earn-withdrawal", programId, withdrawalRef] : null,
    async () => {
      const result = await fetchEarnWithdrawal(programId as string, withdrawalRef as string);
      return result.ok ? result.data.data.withdrawal : undefined;
    },
    {
      refreshInterval: (withdrawal) =>
        withdrawal && SETTLED_WITHDRAWAL_STATUSES.has(withdrawal.status) ? 0 : 5_000,
      dedupingInterval: EARN_PROGRAM_DEDUPING_MS,
    }
  );

  useEffect(() => {
    if (!data || !SETTLED_WITHDRAWAL_STATUSES.has(data.status)) {
      return;
    }
    // Once per withdrawal: polling keeps returning the terminal read.
    if (announced.current === data.withdrawalRef) {
      return;
    }
    announced.current = data.withdrawalRef;
    const message = t(WITHDRAWAL_OUTCOME_KEYS[data.status]);
    if (data.status === "completed") {
      toast.success(message);
    } else {
      // Partial counts as a problem, not a success: some of the money did not
      // arrive, and saying "complete" would be the lie this hook exists to
      // avoid.
      toast.error(message);
    }
    onSettledRef.current?.();
  }, [data, t]);
}
