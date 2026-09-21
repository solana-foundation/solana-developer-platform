"use client";

import {
  EARN_MOVEMENT_STATUSES,
  EARN_TERMINAL_MOVEMENT_STATUSES,
  EARN_TERMINAL_VAULT_MOVEMENT_STATUSES,
  EARN_TERMINAL_WITHDRAWAL_STATUSES,
  EARN_VAULT_MOVEMENT_STATUSES,
  type EarnExternalWalletPosition,
  type EarnExternalWalletPositionSummary,
  type EarnExternalWalletPositionSummaryResponse,
  type EarnPortfolioToken,
  type EarnPortfolioWalletStatus,
  type EarnPortfolioWithdrawal,
  type EarnProgram,
  type EarnProgramWithdrawalPreviewResponse,
  type EarnProgramWithdrawalRecord,
  type EarnProgramWithdrawalResponse,
  type EarnStrategy,
  type EarnVaultDeposit,
  type EarnVaultDepositRecord,
  type EarnVaultDepositRequest,
  type EarnVaultDirectMovementStatus,
  type EarnVaultMovementStatus,
  type EarnVaultPosition,
  type EarnVaultQueuedWithdrawalPreview,
  type EarnVaultQueuedWithdrawalTermsRequest,
  type EarnVaultWithdrawal,
  type EarnVaultWithdrawalOptions,
  type EarnVaultWithdrawalRequest,
  type EarnVaultWithdrawalRequestRecord,
  type EarnVaultWithdrawalRequestStatus,
  type ListEarnProgramsResponse,
  type ListEarnProgramWithdrawalsResponse,
  type ListEarnStrategiesResponse,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "@sdp/types";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { earnQueryKeys } from "./earn-query-key";
import { isEarnVaultQueuedWithdrawalTerminal } from "./earn-vault-queued-withdrawal-presentation";

export type {
  EarnProgram,
  EarnVaultDeposit,
  EarnVaultDepositRecord,
  EarnVaultQueuedWithdrawalPreview,
  EarnVaultWithdrawal,
  EarnVaultWithdrawalOptions,
  EarnVaultWithdrawalRequestRecord,
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

/**
 * `requestJson` plus the gate every plain reader restates: anything but a 2xx
 * carrying a parsable body is a thrown error naming the API's message, never a
 * partial result. (The programs read cannot use this — its 503 is an outcome,
 * not an error.)
 */
async function requestJsonOk<T>(path: string): Promise<T> {
  const { status, body } = await requestJson<T>(path);
  if (status < 200 || status >= 300 || !body) {
    throw new Error(errorMessage(body, status));
  }
  return body;
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

/**
 * The two cadences the earn hooks refresh at, named once so a tuning change
 * cannot miss a surface: the fast one drives feeds derived from live chain
 * reads (program deposits, vault position values), the slow one the
 * recorded-movement ledgers, whose DISCOVERY tier is deliberately calmer —
 * each in-flight movement then runs its own faster watch poll.
 */
const LIVE_FEED_REFRESH_MS = 15_000;
const LEDGER_REFRESH_MS = 30_000;

/**
 * The paging shape every paged earn read shares. The API caps `pageSize` at
 * 100, so a full collection pages at EARN_PAGE_SIZE, and every loop stops hard
 * at EARN_PAGE_LIMIT: a bad `total` or a cursor that never advances must never
 * spin the client (and the BFF it drives) forever. 20 pages × 100 rows is far
 * past anything an organization, a partner wallet, or a single program's
 * ledger can plausibly hold.
 */
const EARN_PAGE_SIZE = 100;
const EARN_PAGE_LIMIT = 20;

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

  for (let page = 1; page <= EARN_PAGE_LIMIT; page += 1) {
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
      `/api/dashboard/markets/earn/programs?page=${page}&pageSize=${EARN_PAGE_SIZE}`
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
    if (body.data.programs.length < EARN_PAGE_SIZE) {
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
 * The provider is hit live on every program read, so `busy` is deliberately slower
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

export function useEarnPrograms() {
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.programs(),
    () => fetchEarnProgramsState(),
    {
      refreshInterval: earnProgramsRefreshInterval,
      dedupingInterval: EARN_PROGRAM_DEDUPING_MS,
    }
  );
  return { state: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * The whole active catalogue. The list endpoint has no provider filter and
 * offers no sort control, so callers filter and order client-side — which only
 * works if every page is actually fetched. Requesting one page of 100 silently
 * dropped everything past it once a second provider synced.
 *
 * `cluster` is the PRO-1742 opt-in: omitted, the API answers the environment's
 * own shelf (the one a caller can act on); named, it browses that cluster's
 * sub-shelf — in practice the sandbox toggle reading the mirrored mainnet
 * catalogue, whose rows arrive `fundable: false`.
 */
export async function fetchEarnStrategies(cluster?: SolanaCluster): Promise<EarnStrategy[]> {
  const strategies: EarnStrategy[] = [];

  for (let page = 1; page <= EARN_PAGE_LIMIT; page += 1) {
    const clusterParam = cluster ? `&cluster=${cluster}` : "";
    const body = await requestJsonOk<{ data: ListEarnStrategiesResponse }>(
      `/api/dashboard/markets/earn/strategies?page=${page}&pageSize=${EARN_PAGE_SIZE}${clusterParam}`
    );

    strategies.push(...body.data.strategies);
    if (strategies.length >= body.data.total) {
      return strategies;
    }
    if (body.data.strategies.length < EARN_PAGE_SIZE) {
      throw new Error("Earn strategies pagination ended before the reported total");
    }
  }

  throw new Error("Earn strategies pagination exceeded its safety limit");
}

export function useEarnStrategies(options?: { cluster?: SolanaCluster }) {
  const cluster = options?.cluster;
  // The cluster is part of the key: two views of different shelves must never
  // serve each other's cache entry, while the default view keeps deduping with
  // every other default caller.
  //
  // keepPreviousData → a cluster-toggle key flip keeps the current rows on
  // screen while the full paged fetch reruns, instead of tearing the table to
  // skeletons (same pattern as activity-tab and wallet-card-balance-value).
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.strategies({ cluster: cluster ?? "environment-default" }),
    () => fetchEarnStrategies(cluster),
    { keepPreviousData: true }
  );
  return { strategies: data, error, isLoading, refresh: () => void mutate() };
}

/** The keyset page both live-position collections return. */
interface PositionPage<Position> {
  positions: Position[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * The cursor-paging loop shared by the two live-position collections. The
 * `seenCursors` guard turns a server that repeats or rewinds its cursor into a
 * thrown error instead of a loop, and the page-limit fallthrough throws rather
 * than returning the prefix collected so far.
 */
async function fetchAllPositionPages<Position>(
  path: (query: URLSearchParams) => string,
  subject: string
): Promise<Position[]> {
  const positions: Position[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  for (let page = 1; page <= EARN_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(EARN_PAGE_SIZE) });
    if (before) query.set("before", before);

    const body = await requestJsonOk<{ data: PositionPage<Position> }>(path(query));

    positions.push(...body.data.positions);
    if (!body.data.hasMore) return positions;

    const nextCursor = body.data.nextCursor;
    if (!nextCursor || nextCursor === before || seenCursors.has(nextCursor)) {
      throw new Error(`${subject} pagination did not advance`);
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  // A partial portfolio is worse than an error because it can hide money.
  throw new Error(`${subject} pagination exceeded its safety limit`);
}

/**
 * Reads every vault position held by the selected project. The API uses an
 * opaque keyset cursor and hydrates balances live from chain, so cursor
 * progression — not row count — decides when the read is complete.
 */
export async function fetchEarnVaultPositions(): Promise<EarnVaultPosition[]> {
  return fetchAllPositionPages<EarnVaultPosition>(
    (query) => `/api/dashboard/markets/earn/vault-positions?${query}`,
    "Vault positions"
  );
}

/** Live position values refresh while the surface is mounted. */
export function useEarnVaultPositions() {
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.vaultPositions(),
    () => fetchEarnVaultPositions(),
    { refreshInterval: LIVE_FEED_REFRESH_MS }
  );
  return { positions: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * Reads every live position for exactly one partner end-user wallet.
 * Kept at the strict dashboard boundary for the planned wallet drill-down.
 */
export async function fetchEarnExternalWalletPositions(
  ownerAddress: string
): Promise<EarnExternalWalletPosition[]> {
  return fetchAllPositionPages<EarnExternalWalletPosition>(
    (query) =>
      `/api/dashboard/markets/earn/external-wallet/positions/${encodeURIComponent(ownerAddress)}?${query}`,
    "External-wallet positions"
  );
}

export async function fetchEarnExternalWalletPositionSummary(): Promise<EarnExternalWalletPositionSummary> {
  const body = await requestJsonOk<{ data: EarnExternalWalletPositionSummaryResponse }>(
    "/api/dashboard/markets/earn/external-wallet/positions/summary"
  );
  return body.data.summary;
}

export function earnExternalWalletSummaryRefreshInterval(
  detailsVisible: boolean,
  environment = process.env.NODE_ENV
): number {
  if (environment === "development") return 3_000;
  return detailsVisible ? 15_000 : 60_000;
}

/** Live customer portfolio totals refresh while the Embedded Yield dashboard is mounted. */
export function useEarnExternalWalletPositionSummary({
  detailsVisible = false,
}: {
  detailsVisible?: boolean;
} = {}) {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-external-wallet-position-summary",
    () => fetchEarnExternalWalletPositionSummary(),
    {
      refreshInterval: earnExternalWalletSummaryRefreshInterval(detailsVisible),
    }
  );
  return {
    summary: data,
    error,
    isInitialLoading: isLoading && data === undefined,
    refresh: () => void mutate(),
  };
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

/**
 * The API's 202 approval hold, identical for deposits and withdrawals: the
 * custody wallet still owes the transaction a signature. One schema for both
 * outcome unions so the pending arm cannot drift between the two mirrors.
 */
const signingPendingOutcomeSchema = z
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
  }));

const earnVaultDepositOutcomeSchema = z.union([
  z
    .object({ data: earnVaultDepositSchema })
    .transform(({ data }) => ({ kind: "submitted" as const, deposit: data })),
  signingPendingOutcomeSchema,
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
    ...(input.sourceTokenMint === undefined ? {} : { sourceTokenMint: input.sourceTokenMint }),
    ...(input.swapSlippageBps === undefined ? {} : { swapSlippageBps: input.swapSlippageBps }),
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

const VAULT_MOVEMENTS_PAGE_SIZE = 100;

/**
 * Hard stop on the paging loop, same reason as the other readers: a server that
 * never stops advancing its cursor must not spin forever. 20 pages x 100 is far
 * past any plausible number of simultaneously in-flight vault movements.
 */
const VAULT_MOVEMENTS_PAGE_LIMIT = 20;

interface VaultMovementPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

async function fetchAllVaultMovementPages<T>(input: {
  resource: "deposits" | "withdrawals";
  settled?: boolean;
  parsePage: (value: unknown) => VaultMovementPage<T> | null;
}): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let before: string | null = null;

  for (let page = 0; page < VAULT_MOVEMENTS_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(VAULT_MOVEMENTS_PAGE_SIZE) });
    if (input.settled !== undefined) query.set("settled", String(input.settled));
    if (before) query.set("before", before);

    const result = await dashboardFetch<unknown>(
      `/api/dashboard/markets/earn/vault-${input.resource}?${query.toString()}`
    );
    if (!result.ok) throw new Error(result.error);
    const body = input.parsePage(result.data);
    if (!body) throw new Error(`Invalid vault ${input.resource} response`);

    items.push(...body.items);
    if (!body.hasMore) return items;

    const nextCursor = body.nextCursor;
    if (!nextCursor || nextCursor === before || seenCursors.has(nextCursor)) {
      throw new Error(`Vault ${input.resource} pagination did not advance`);
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  throw new Error(`Vault ${input.resource} pagination exceeded its safety limit`);
}

/**
 * This workspace's recorded deposits, newest first. The API derives the
 * organization and project itself from the session, so this takes no scope
 * argument — passing one would be a second, drifting copy of the boundary.
 *
 * PAGES TO THE END and fails loudly rather than truncating, like
 * `fetchEarnVaultPositions` and `fetchEarnStrategies`. A silently short page
 * here is a deposit that stops being tracked: its terminal status is never
 * reflected in the table and the balances it changed are never refreshed.
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
  return fetchAllVaultMovementPages({
    resource: "deposits",
    settled: options.settled,
    parsePage(value) {
      const parsed = earnVaultDepositsPageSchema.safeParse(value);
      if (!parsed.success) return null;
      return {
        items: parsed.data.data.deposits,
        hasMore: parsed.data.data.hasMore,
        nextCursor: parsed.data.data.nextCursor,
      };
    },
  });
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

/** Why a quote declines to price a request; both preview envelopes carry it. */
const vaultPreviewBlockingIssues = z.array(z.object({ code: z.string(), message: z.string() }));

const earnVaultDepositPreviewEnvelopeSchema = z.object({
  data: z.object({
    strategyId: z.string(),
    /** Shares at the provider's live rate, decimal string at share scale. */
    sharesOut: z.string().regex(/^\d+(\.\d+)?$/),
    shareDecimals: z.number().int().min(0).max(38),
    blockingIssues: vaultPreviewBlockingIssues,
    /**
     * SDP intends to sponsor this movement's network fee and rent. Optional
     * for deploy skew against an older API; absent renders wallet-pays copy,
     * the safe prior. Swap-funded deposits force wallet-pays client-side.
     */
    feeSponsored: z.boolean().optional(),
  }),
});

export type EarnVaultDepositPreview = z.infer<typeof earnVaultDepositPreviewEnvelopeSchema>["data"];

export type EarnVaultDepositPreviewResult =
  | { kind: "quoted"; preview: EarnVaultDepositPreview }
  | { kind: "unavailable" };

/**
 * What the vault would mint for this amount right now — the live rate the
 * deposit modal derives its `minSharesOut` floor from. `unavailable` covers
 * every failure the same way: a floor must come from a quote or not exist, so
 * an unreadable quote DISABLES the deposit rather than falling back to
 * arithmetic on the amount (which is only correct while the rate is 1:1).
 */
export async function fetchEarnVaultDepositPreview(
  input: { strategyId: string; amount: string },
  signal?: AbortSignal
): Promise<EarnVaultDepositPreviewResult> {
  const result = await dashboardFetch<unknown>(
    "/api/dashboard/markets/earn/vault-deposit-previews",
    {
      method: "POST",
      body: { strategyId: input.strategyId, amount: input.amount },
      signal,
    }
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = earnVaultDepositPreviewEnvelopeSchema.safeParse(result.data);
  if (!parsed.success) return { kind: "unavailable" };
  return { kind: "quoted", preview: parsed.data.data };
}

const earnVaultWithdrawalPreviewEnvelopeSchema = z.object({
  data: z.object({
    positionId: z.string(),
    /** Deposit-token amount at the provider's live rate, decimal string. */
    assetsOut: z.string().regex(/^\d+(\.\d+)?$/),
    assetDecimals: z.number().int().min(0).max(38),
    blockingIssues: vaultPreviewBlockingIssues,
    /** Same sponsorship intent as the deposit preview; exits have no swap. */
    feeSponsored: z.boolean().optional(),
  }),
});

export type EarnVaultWithdrawalPreview = z.infer<
  typeof earnVaultWithdrawalPreviewEnvelopeSchema
>["data"];

export type EarnVaultWithdrawalPreviewResult =
  | { kind: "quoted"; preview: EarnVaultWithdrawalPreview }
  | { kind: "unavailable" };

/**
 * What redeeming these shares would pay right now — the exit twin of
 * `fetchEarnVaultDepositPreview`, with the same fail-closed rule: a floor must
 * come from a quote or not exist, so an unreadable quote DISABLES the exit
 * confirm rather than guessing a number.
 */
export async function fetchEarnVaultWithdrawalPreview(
  input: { positionId: string; shares: string },
  signal?: AbortSignal
): Promise<EarnVaultWithdrawalPreviewResult> {
  const result = await dashboardFetch<unknown>(
    "/api/dashboard/markets/earn/vault-withdrawal-previews",
    {
      method: "POST",
      body: { positionId: input.positionId, shares: input.shares },
      signal,
    }
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = earnVaultWithdrawalPreviewEnvelopeSchema.safeParse(result.data);
  if (!parsed.success) return { kind: "unavailable" };
  return { kind: "quoted", preview: parsed.data.data };
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
    earnQueryKeys.vaultDepositsInFlight(),
    () => fetchEarnVaultDeposits({ settled: false }),
    { refreshInterval: LEDGER_REFRESH_MS }
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

const VAULT_MOVEMENT_FAST_POLL_WINDOW_MS = 15_000;
const VAULT_MOVEMENT_MEDIUM_POLL_WINDOW_MS = 60_000;
const VAULT_MOVEMENT_FAST_POLL_MS = 1_000;
const VAULT_MOVEMENT_MEDIUM_POLL_MS = 2_500;
const VAULT_MOVEMENT_SLOW_POLL_MS = 5_000;
const VAULT_MOVEMENT_DEDUPING_MS = 750;

/**
 * Poll aggressively while Solana is likely advancing the transaction, then
 * back off without ever replacing the settled table content with a skeleton.
 */
export function earnVaultMovementRefreshInterval(input: {
  settled: boolean;
  startedAt: number;
  now?: number;
}): number {
  if (input.settled) return 0;
  const elapsed = Math.max(0, (input.now ?? Date.now()) - input.startedAt);
  if (elapsed < VAULT_MOVEMENT_FAST_POLL_WINDOW_MS) return VAULT_MOVEMENT_FAST_POLL_MS;
  if (elapsed < VAULT_MOVEMENT_MEDIUM_POLL_WINDOW_MS) return VAULT_MOVEMENT_MEDIUM_POLL_MS;
  return VAULT_MOVEMENT_SLOW_POLL_MS;
}

function useVaultMovementPollStartedAt(movementId: string | undefined): number {
  return useMemo(() => ({ movementId, startedAt: Date.now() }), [movementId]).startedAt;
}

function vaultMovementVersion(movement: {
  movementId: string;
  status: string;
  failureReason: string | null;
  confirmedAt: string | null;
  settledAt?: string | null;
}): string {
  return [
    movement.movementId,
    movement.status,
    movement.failureReason ?? "",
    movement.confirmedAt ?? "",
    movement.settledAt ?? "",
  ].join(":");
}

interface WatchableVaultMovement {
  movementId: string;
  status: string;
  failureReason: string | null;
  confirmedAt: string | null;
  settledAt?: string | null;
}

function useEarnVaultMovementOutcome<Movement extends WatchableVaultMovement>(input: {
  movementId: string | undefined;
  queryKey: readonly [string, string] | null;
  fetchMovement: (movementId: string) => Promise<Movement | undefined>;
  isSettled: (movement: Movement) => boolean;
  onSettled?: (movement: Movement) => void;
  onUpdated?: (movement: Movement) => void;
}): Movement | undefined {
  const { movementId, queryKey, fetchMovement, isSettled, onSettled, onUpdated } = input;
  const reported = useRef<string | undefined>(undefined);
  const reportedVersion = useRef<string | undefined>(undefined);
  const pollStartedAt = useVaultMovementPollStartedAt(movementId);

  const { data } = useSWR(queryKey, ([, watchedId]) => fetchMovement(watchedId), {
    refreshInterval: (movement) =>
      earnVaultMovementRefreshInterval({
        settled: Boolean(movement && isSettled(movement)),
        startedAt: pollStartedAt,
      }),
    dedupingInterval: VAULT_MOVEMENT_DEDUPING_MS,
    onSuccess: (movement) => {
      if (!movement) return;
      const version = vaultMovementVersion(movement);
      if (reportedVersion.current !== version) {
        reportedVersion.current = version;
        onUpdated?.(movement);
      }
      if (!isSettled(movement) || reported.current === movement.movementId) return;
      reported.current = movement.movementId;
      onSettled?.(movement);
    },
  });

  return data;
}

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

function isEarnVaultDepositSettled(deposit: EarnVaultDepositRecord): boolean {
  return SETTLED_VAULT_MOVEMENT_STATUSES.has(deposit.status);
}

/**
 * Watch how a submitted vault deposit actually ends, and report it to the
 * mounted product surface exactly once.
 *
 * `POST /vault-deposits` records the signed transaction BEFORE broadcasting it,
 * so its response is a receipt for a signature, not for a holding. Between that
 * receipt and the chain there are three real outcomes: landed, rejected, or
 * the blockhash expired without it ever landing. The detail read observes the
 * signature directly for fast feedback, while the scheduled reconciliation
 * sweep remains the durable fallback. This watches the movement until it says
 * one of them.
 *
 * Polls until the status is terminal (`confirmed | failed`), then reports once.
 * Passing `undefined` (nothing deposited this session) does nothing and
 * issues no requests. The hook deliberately owns no toast or transient UI;
 * Treasury renders the live state beside the affected position instead.
 *
 * `onSettled` fires once with the terminal movement so the caller can refresh
 * the balances it changed and retire the active watch.
 */
export function useEarnVaultDepositOutcome(
  movementId: string | undefined,
  onSettled?: (deposit: EarnVaultDepositRecord) => void,
  onUpdated?: (deposit: EarnVaultDepositRecord) => void
): EarnVaultDepositRecord | undefined {
  return useEarnVaultMovementOutcome({
    movementId,
    queryKey: movementId ? earnQueryKeys.vaultDeposit({ movementId }) : null,
    fetchMovement: fetchEarnVaultDeposit,
    isSettled: isEarnVaultDepositSettled,
    onSettled,
    onUpdated,
  });
}

// ---------------------------------------------------------------------------
// Vault withdrawals (PRO-1702) — the deposit seam's exit mirror. One
// deliberate vocabulary difference: this surface speaks the unified LEDGER's
// own statuses (`requested … finalized`). Customer UI treats `confirmed` as
// Done, while this background watcher continues through the durable ledger
// outcome. Everything here therefore keys watcher terminality on
// `EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct`, never the legacy deposit set.
// ---------------------------------------------------------------------------

/**
 * Annotated shared withdrawal schemas for the same reason the deposit
 * schemas are: a field added or renamed in `@sdp/types` must fail typecheck
 * here rather than be silently stripped from a parsed leg.
 */
const earnVaultWithdrawalSchema: z.ZodType<EarnVaultWithdrawal> = z.object({
  movementId: z.string(),
  positionId: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  status: z.enum(EARN_MOVEMENT_STATUSES.vault_direct),
  signature: z.string(),
  shares: z.string(),
  shareMint: z.string(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  replayed: z.boolean().optional(),
});

const earnVaultWithdrawalOutcomeSchema = z.union([
  z
    .object({ data: z.object({ withdrawal: earnVaultWithdrawalSchema }) })
    .transform(({ data }) => ({ kind: "submitted" as const, withdrawal: data.withdrawal })),
  signingPendingOutcomeSchema,
]);

export type EarnVaultWithdrawalOutcome = z.infer<typeof earnVaultWithdrawalOutcomeSchema>;

/**
 * Exit a vault position back to the custody wallet that holds it. Same
 * body-rebuild and 202-contract rules as `createEarnVaultDeposit`: the caller
 * cannot smuggle fields into a value-moving request, and an approval hold is
 * accepted only on a 202.
 */
export async function createEarnVaultWithdrawal(
  input: EarnVaultWithdrawalRequest,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<DashboardFetchResult<EarnVaultWithdrawalOutcome>> {
  const body: EarnVaultWithdrawalRequest = {
    positionId: input.positionId,
    shares: input.shares,
    ...(input.minAmountOut === undefined ? {} : { minAmountOut: input.minAmountOut }),
  };
  const result = await dashboardFetch<unknown>("/api/dashboard/markets/earn/vault-withdrawals", {
    method: "POST",
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body,
    signal,
  });

  if (!result.ok) return result;

  const invalid = {
    ok: false,
    error: "Invalid vault withdrawal response",
    status: result.status,
    body: result.data,
  } as const;

  const parsed = earnVaultWithdrawalOutcomeSchema.safeParse(result.data);
  if (!parsed.success) return invalid;
  if (parsed.data.kind === "approval_pending" && result.status !== 202) return invalid;

  return { ok: true, status: result.status, data: parsed.data };
}

const earnVaultWithdrawalResponseSchema = z.object({
  data: z.object({ withdrawal: earnVaultWithdrawalSchema }),
});

/**
 * Read one recorded withdrawal. `undefined` for every unusable answer, and
 * deliberately NOT terminal — the caller keeps polling, because a read that
 * failed says nothing about whether the exit landed.
 */
export async function fetchEarnVaultWithdrawal(
  movementId: string
): Promise<EarnVaultWithdrawal | undefined> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-withdrawals/${encodeURIComponent(movementId)}`
  );
  if (!result.ok) return undefined;
  const parsed = earnVaultWithdrawalResponseSchema.safeParse(result.data);
  return parsed.success ? parsed.data.data.withdrawal : undefined;
}

const earnVaultWithdrawalsPageSchema = z.object({
  data: z.object({
    withdrawals: z.array(earnVaultWithdrawalSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/**
 * This workspace's recorded withdrawals, newest first. PAGES TO THE END
 * and fails loudly rather than truncating, exactly like the deposits reader —
 * a silently short page here is an exit that stops being tracked.
 */
export async function fetchEarnVaultWithdrawals(
  options: { settled?: boolean } = {}
): Promise<EarnVaultWithdrawal[]> {
  return fetchAllVaultMovementPages({
    resource: "withdrawals",
    settled: options.settled,
    parsePage(value) {
      const parsed = earnVaultWithdrawalsPageSchema.safeParse(value);
      if (!parsed.success) return null;
      return {
        items: parsed.data.data.withdrawals,
        hasMore: parsed.data.data.hasMore,
        nextCursor: parsed.data.data.nextCursor,
      };
    },
  });
}

/**
 * The movement a given idempotency key produced, if one exists yet. The held-key
 * pre-flight for the approval path, with the same three-outcome contract as
 * the deposit's: collapsing `unavailable` into `absent` would let a failed
 * read reuse a spent key.
 */
export type EarnVaultWithdrawalsByRequestId =
  | { kind: "found"; withdrawal: EarnVaultWithdrawal }
  | { kind: "absent" }
  | { kind: "unavailable" };

export async function fetchEarnVaultWithdrawalsByRequestId(
  requestId: string
): Promise<EarnVaultWithdrawalsByRequestId> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-withdrawals?requestId=${encodeURIComponent(requestId)}`
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = earnVaultWithdrawalsPageSchema.safeParse(result.data);
  if (!parsed.success) return { kind: "unavailable" };
  const [withdrawal] = parsed.data.data.withdrawals;
  return withdrawal ? { kind: "found", withdrawal } : { kind: "absent" };
}

/**
 * The DISCOVERY tier for in-flight withdrawals, 30s, mirroring
 * `useEarnVaultDeposits`, and the reason an exit signed before a reload, in
 * another tab, or unblocked by a policy approval minutes later becomes
 * visible (and watched) again.
 */
export function useEarnVaultWithdrawals() {
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.vaultWithdrawalsInFlight(),
    () => fetchEarnVaultWithdrawals({ settled: false }),
    { refreshInterval: LEDGER_REFRESH_MS }
  );
  return { withdrawals: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * The unified ledger's terminal set for a vault movement: `finalized | failed`.
 * NOT the legacy deposit set — on this surface `confirmed` is optimistic chain
 * commitment that a fork can still drop, and a poll that stopped there would
 * announce a settlement the chain has not finished making.
 */
const SETTLED_VAULT_WITHDRAWAL_STATUSES: ReadonlySet<EarnVaultDirectMovementStatus> = new Set(
  EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct
);

/** Shared by the recovery filter and the poll's stop condition — one rule. */
export function isEarnVaultWithdrawalInFlight(withdrawal: EarnVaultWithdrawal): boolean {
  return !SETTLED_VAULT_WITHDRAWAL_STATUSES.has(withdrawal.status);
}

function isEarnVaultWithdrawalSettled(withdrawal: EarnVaultWithdrawal): boolean {
  return SETTLED_VAULT_WITHDRAWAL_STATUSES.has(withdrawal.status);
}

/**
 * Watch a recorded withdrawal until it settles. The caller owns the visible
 * state so a long-running chain operation is never reduced to a toast.
 */
export function useEarnVaultWithdrawalOutcome(
  movementId: string | undefined,
  onSettled?: (withdrawal: EarnVaultWithdrawal) => void,
  onUpdated?: (withdrawal: EarnVaultWithdrawal) => void
): EarnVaultWithdrawal | undefined {
  return useEarnVaultMovementOutcome({
    movementId,
    queryKey: movementId ? earnQueryKeys.vaultWithdrawal({ movementId }) : null,
    fetchMovement: fetchEarnVaultWithdrawal,
    isSettled: isEarnVaultWithdrawalSettled,
    onSettled,
    onUpdated,
  });
}

// ---------------------------------------------------------------------------
// Queued vault withdrawals — a provider obligation, not a movement. Landing
// the request escrows shares; only a later solver fulfilment pays assets.
// ---------------------------------------------------------------------------

const queuedWithdrawalIssueSchema = z.object({ code: z.string(), message: z.string() });
const queuedWithdrawalTermsSchema = z.object({
  assetMint: z.string(),
  allowWithdrawals: z.boolean(),
  secondsToMaturity: z.number().int().nonnegative(),
  minimumSecondsToDeadline: z.number().int().nonnegative(),
  minimumDiscountBps: z.number().int().nonnegative(),
  maximumDiscountBps: z.number().int().nonnegative(),
  minimumShares: z.string(),
  shareDecimals: z.number().int().min(0).max(38),
});

const earnVaultWithdrawalOptionsSchema: z.ZodType<EarnVaultWithdrawalOptions> = z.object({
  positionId: z.string(),
  instant: z.boolean(),
  queued: z.boolean(),
  withdrawAuthority: z.string().nullable(),
  queueState: z.string().nullable(),
  queueAsset: queuedWithdrawalTermsSchema.nullable(),
});

const earnVaultQueuedWithdrawalPreviewSchema: z.ZodType<EarnVaultQueuedWithdrawalPreview> =
  z.object({
    positionId: z.string(),
    assetMint: z.string(),
    shares: z.string(),
    shareDecimals: z.number().int().min(0).max(38),
    assets: z.string(),
    assetDecimals: z.number().int().min(0).max(38),
    discountBps: z.number().int().nonnegative(),
    maturityTimestamp: z.string().regex(/^\d+$/),
    deadlineTimestamp: z.string().regex(/^\d+$/),
    blockingIssues: z.array(queuedWithdrawalIssueSchema),
  });

const EARN_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "creating",
  "pending",
  "fulfillable",
  "expiredCancelable",
  "cancelling",
  "fulfilled",
  "cancelled",
  "closedOrUnknown",
  "failed",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

const earnVaultWithdrawalRequestRecordSchema: z.ZodType<EarnVaultWithdrawalRequestRecord> =
  z.object({
    withdrawalRequestId: z.string(),
    positionId: z.string(),
    provider: z.string(),
    providerReference: z.string(),
    ownerAddress: z.string(),
    requestAddress: z.string(),
    status: z.enum(EARN_VAULT_WITHDRAWAL_REQUEST_STATUSES),
    assetMint: z.string(),
    shareMint: z.string(),
    shares: z.string(),
    quotedAssets: z.string(),
    shareDecimals: z.number().int().min(0).max(38),
    assetDecimals: z.number().int().min(0).max(38),
    discountBps: z.number().int().nonnegative(),
    nonce: z.string().regex(/^\d+$/).nullable(),
    creationTimestamp: z.string().regex(/^\d+$/).nullable(),
    maturityTimestamp: z.string().regex(/^\d+$/),
    deadlineTimestamp: z.string().regex(/^\d+$/),
    creationSignature: z.string().nullable(),
    cancelSignature: z.string().nullable(),
    closingSignature: z.string().nullable(),
    assetsPaid: z.string().nullable(),
    failureReason: z.string().nullable(),
    fulfilledAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    replayed: z.boolean().optional(),
  });

type QueuedReadResult<T> = { kind: "ready"; value: T } | { kind: "unavailable" };

/** Read both routes independently. No client-side provider list chooses one. */
export async function fetchEarnVaultWithdrawalOptions(
  positionId: string,
  signal?: AbortSignal
): Promise<QueuedReadResult<EarnVaultWithdrawalOptions>> {
  const result = await dashboardFetch<unknown>(
    "/api/dashboard/markets/earn/vault-withdrawal-options",
    { method: "POST", body: { positionId }, signal }
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = z.object({ data: earnVaultWithdrawalOptionsSchema }).safeParse(result.data);
  return parsed.success ? { kind: "ready", value: parsed.data.data } : { kind: "unavailable" };
}

export async function fetchEarnVaultQueuedWithdrawalPreview(
  input: EarnVaultQueuedWithdrawalTermsRequest,
  signal?: AbortSignal
): Promise<QueuedReadResult<EarnVaultQueuedWithdrawalPreview>> {
  const result = await dashboardFetch<unknown>(
    "/api/dashboard/markets/earn/vault-queued-withdrawal-previews",
    { method: "POST", body: input, signal }
  );
  if (!result.ok) return { kind: "unavailable" };
  const parsed = z.object({ data: earnVaultQueuedWithdrawalPreviewSchema }).safeParse(result.data);
  return parsed.success ? { kind: "ready", value: parsed.data.data } : { kind: "unavailable" };
}

const queuedMutationEnvelopeSchema = z.object({
  data: z.object({ withdrawalRequest: earnVaultWithdrawalRequestRecordSchema }),
});

const earnVaultQueuedWithdrawalOutcomeSchema = z.union([
  queuedMutationEnvelopeSchema.transform(({ data }) => ({
    kind: "submitted" as const,
    withdrawalRequest: data.withdrawalRequest,
  })),
  signingPendingOutcomeSchema,
]);

export type EarnVaultQueuedWithdrawalOutcome = z.infer<
  typeof earnVaultQueuedWithdrawalOutcomeSchema
>;

export async function createEarnVaultWithdrawalRequest(
  input: EarnVaultQueuedWithdrawalTermsRequest,
  idempotencyKey: string
): Promise<DashboardFetchResult<EarnVaultQueuedWithdrawalOutcome>> {
  const body: EarnVaultQueuedWithdrawalTermsRequest = {
    positionId: input.positionId,
    shares: input.shares,
    discountBps: input.discountBps,
    deadlineSeconds: input.deadlineSeconds,
  };
  const result = await dashboardFetch<unknown>(
    "/api/dashboard/markets/earn/vault-withdrawal-requests",
    {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body,
    }
  );
  if (!result.ok) return result;
  const parsed = earnVaultQueuedWithdrawalOutcomeSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid queued withdrawal response",
      status: result.status,
      body: result.data,
    };
  }
  if (parsed.data.kind === "approval_pending" && result.status !== 202) {
    return {
      ok: false,
      error: "Invalid queued withdrawal response",
      status: result.status,
      body: result.data,
    };
  }
  return { ok: true, status: result.status, data: parsed.data };
}

export async function cancelEarnVaultWithdrawalRequest(
  withdrawalRequestId: string,
  idempotencyKey: string
): Promise<DashboardFetchResult<EarnVaultWithdrawalRequestRecord>> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-withdrawal-requests/${encodeURIComponent(withdrawalRequestId)}/cancel`,
    {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: {},
    }
  );
  if (!result.ok) return result;
  const parsed = queuedMutationEnvelopeSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid queued withdrawal cancellation response",
      status: result.status,
      body: result.data,
    };
  }
  return { ok: true, status: result.status, data: parsed.data.data.withdrawalRequest };
}

export async function fetchEarnVaultWithdrawalRequest(
  withdrawalRequestId: string
): Promise<EarnVaultWithdrawalRequestRecord | undefined> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/vault-withdrawal-requests/${encodeURIComponent(withdrawalRequestId)}`
  );
  if (!result.ok) return undefined;
  const parsed = queuedMutationEnvelopeSchema.safeParse(result.data);
  return parsed.success ? parsed.data.data.withdrawalRequest : undefined;
}

const queuedRequestPageSchema = z.object({
  data: z.object({
    withdrawalRequests: z.array(earnVaultWithdrawalRequestRecordSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export async function fetchEarnVaultWithdrawalRequests(
  options: { settled?: boolean } = {}
): Promise<EarnVaultWithdrawalRequestRecord[]> {
  const requests: EarnVaultWithdrawalRequestRecord[] = [];
  const seen = new Set<string>();
  let before: string | undefined;

  for (let page = 0; page < EARN_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(EARN_PAGE_SIZE) });
    if (before) query.set("before", before);
    if (options.settled !== undefined) query.set("settled", String(options.settled));
    const result = await dashboardFetch<unknown>(
      `/api/dashboard/markets/earn/vault-withdrawal-requests?${query}`
    );
    if (!result.ok) throw new Error(result.error);
    const parsed = queuedRequestPageSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Invalid queued withdrawal request page");
    requests.push(...parsed.data.data.withdrawalRequests);
    if (!parsed.data.data.hasMore) return requests;
    const next = parsed.data.data.nextCursor;
    if (!next || next === before || seen.has(next)) {
      throw new Error("Queued withdrawal request pagination did not advance");
    }
    seen.add(next);
    before = next;
  }
  throw new Error("Queued withdrawal request pagination exceeded its safety limit");
}

export function isEarnVaultWithdrawalRequestInFlight(
  request: EarnVaultWithdrawalRequestRecord
): boolean {
  return !isEarnVaultQueuedWithdrawalTerminal(request.status);
}

export function useEarnVaultWithdrawalRequests() {
  const { data, error, isLoading, mutate } = useSWR(
    earnQueryKeys.vaultWithdrawalRequestsOpen(),
    async () =>
      (await fetchEarnVaultWithdrawalRequests({ settled: false })).filter(
        isEarnVaultWithdrawalRequestInFlight
      ),
    { refreshInterval: LEDGER_REFRESH_MS }
  );
  return { withdrawalRequests: data, error, isLoading, refresh: () => void mutate() };
}

export function useEarnVaultWithdrawalRequestOutcome(
  withdrawalRequestId: string | undefined,
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void,
  onUpdated?: (request: EarnVaultWithdrawalRequestRecord) => void
): EarnVaultWithdrawalRequestRecord | undefined {
  const onSettledEvent = useEffectEvent((request: EarnVaultWithdrawalRequestRecord) =>
    onSettled?.(request)
  );
  const onUpdatedEvent = useEffectEvent((request: EarnVaultWithdrawalRequestRecord) =>
    onUpdated?.(request)
  );
  const reportedSettledId = useRef<string | null>(null);
  const { data } = useSWR(
    withdrawalRequestId ? earnQueryKeys.vaultWithdrawalRequest({ withdrawalRequestId }) : null,
    () => fetchEarnVaultWithdrawalRequest(withdrawalRequestId ?? ""),
    {
      refreshInterval: (latest) =>
        latest && !isEarnVaultWithdrawalRequestInFlight(latest) ? 0 : 5_000,
    }
  );

  useEffect(() => {
    if (!data) return;
    // Poll results are server events, not render-derived state: the request
    // only exists after the child submits, so the parent cannot fetch it
    // earlier. Forwarding each polled record and its one-time settlement to
    // the caller's callback is the notification itself, not a render bypass.
    // react-doctor-disable-next-line no-pass-data-to-parent no-pass-live-state-to-parent -- server-poll lifecycle notifications
    onUpdatedEvent(data);
    if (
      !isEarnVaultWithdrawalRequestInFlight(data) &&
      reportedSettledId.current !== data.withdrawalRequestId
    ) {
      reportedSettledId.current = data.withdrawalRequestId;
      // react-doctor-disable-next-line no-pass-data-to-parent no-pass-live-state-to-parent -- server-poll lifecycle notifications
      onSettledEvent(data);
    }
  }, [data]);

  return data;
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

  for (let page = 1; page <= EARN_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(EARN_PAGE_SIZE),
    });
    const body = await requestJsonOk<{ data: ListEarnProgramWithdrawalsResponse }>(
      `${programPath(programId, "/withdrawals")}?${query}`
    );

    const ledgerPage = body.data;
    if (ledgerPage.page !== page || ledgerPage.pageSize !== EARN_PAGE_SIZE) {
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
    if (ledgerPage.withdrawals.length < EARN_PAGE_SIZE) {
      throw new Error("Earn withdrawal ledger pagination ended before the reported total");
    }
  }

  throw new Error("Earn withdrawal ledger pagination exceeded its safety limit");
}

/** Passing no program id issues no ledger request. */
export function useEarnProgramWithdrawals(programId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR(
    programId ? earnQueryKeys.programWithdrawals({ programId }) : null,
    () => fetchEarnProgramWithdrawals(programId as string),
    // Detect withdrawals created from another session while this dashboard is
    // open; the list is a cheap local-DB read and live outcome polling begins
    // only for provider-accepted nonterminal rows.
    { refreshInterval: LEDGER_REFRESH_MS }
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
  const notifySettled = useEffectEvent(() => onSettled?.());

  const { data } = useSWR(
    programId && withdrawalRef ? earnQueryKeys.withdrawal({ programId, withdrawalRef }) : null,
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
    notifySettled();
  }, [data, t]);
}
