"use client";

import type {
  EarnPortfolioAllocationInput,
  EarnPortfolioDepositsPage,
  EarnPortfolioToken,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWalletStatus,
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalPreview,
  EarnPortfolioYield,
  EarnProviderId,
  EarnStrategy,
  ListEarnStrategiesResponse,
} from "@sdp/types";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";

/**
 * Live Earn data access for the dashboard, over the /api/dashboard/markets/earn
 * BFF proxies. The overview keys everything off ONE shared portfolio program
 * per (organization, environment) — provider is pinned to Ground until a
 * second portfolio-capable provider ships and provider selection becomes a
 * product surface.
 */
export const EARN_PORTFOLIO_PROVIDER: EarnProviderId = "ground";

/** Mirrors the sdp-api program envelope (route-owned there, thin enough to pin here). */
export interface EarnProgram {
  provider: string;
  label: string | null;
  createdAt: string;
  wallet: EarnPortfolioWalletSnapshot;
  /** Absent when the provider's yield lookup failed — render no rate, not 0%. */
  yield?: EarnPortfolioYield;
}

/**
 * Program read outcome. `none` (upstream 404) drives the onboarding hero;
 * `unconfigured` (upstream 503, provider credentials missing) renders a quiet
 * notice instead of crashing the overview.
 */
export type EarnProgramState =
  | { kind: "active"; program: EarnProgram }
  | { kind: "none" }
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

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return `Request failed (${status})`;
}

async function fetchEarnProgramState(): Promise<EarnProgramState> {
  const { status, body } = await requestJson<{ data: { program: EarnProgram } }>(
    `/api/dashboard/markets/earn/program?provider=${EARN_PORTFOLIO_PROVIDER}`
  );
  if (status === 404) return { kind: "none" };
  if (status === 503) return { kind: "unconfigured" };
  if (status < 200 || status >= 300 || !body) {
    throw new Error(errorMessage(body, status));
  }
  return { kind: "active", program: body.data.program };
}

/**
 * Poll cadence per wallet status — a property of the WALLET, never of the
 * caller. Every surface reads the same live provider snapshot, and none of
 * them wants a state that stops converging: `creating` blocks the funding step
 * on a deposit address that does not exist yet, and `busy` means the provider
 * is mid-withdrawal or mid-rebalance, so the figures on screen are already
 * out of date. `ready` and `failed` are absent (⇒ 0): a settled program and a
 * terminal failure issue no extra provider reads.
 *
 * Ground is hit live on every program read, so `busy` is deliberately slower
 * than `creating`: against a ~40s observed settle the reader loses nothing
 * perceptible and the provider takes a quarter of the requests.
 */
const WALLET_POLL_MS: Partial<Record<EarnPortfolioWalletStatus, number>> = {
  creating: 4_000,
  busy: 10_000,
};

/**
 * Poll cadence for a given program read; 0 means stop. Exported so the rule is
 * assertable — a browser cannot prove it, because SWR suspends the interval
 * whenever the tab is hidden.
 */
export function earnProgramRefreshInterval(state: EarnProgramState | undefined): number {
  return state?.kind === "active" ? (WALLET_POLL_MS[state.program.wallet.status] ?? 0) : 0;
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
 */
export function useEarnWalletActivityToasts(state: EarnProgramState | undefined) {
  const t = useTranslations();
  const previous = useRef<EarnPortfolioWalletSnapshot | undefined>(undefined);

  useEffect(() => {
    const wallet = state?.kind === "active" ? state.program.wallet : undefined;
    const before = previous.current;
    previous.current = wallet;

    // Nothing to compare against yet, or the wallet was never busy, or it is
    // still busy — no completion has been observed.
    if (!before || !wallet || before.status !== "busy" || wallet.status === "busy") {
      return;
    }
    if (wallet.status === "failed") {
      toast.error(t("DashboardEarn.overview.activityFailed"));
      return;
    }
    // A withdrawal is NOT announced here. This transition only says the
    // provider stopped working — a failed or partial payout leaves the wallet
    // exactly as idle as a settled one — so the outcome comes from
    // `useEarnWithdrawalOutcomeToast`, which reads the withdrawal itself.
    if (before.activity === "withdrawing") {
      return;
    }
    toast.success(
      t(
        before.activity === "rebalancing"
          ? "DashboardEarn.overview.activityRebalanceComplete"
          : // A busy state this build does not recognize still completed; say
            // so without claiming which operation it was, and without
            // claiming anything about money.
            "DashboardEarn.overview.activityComplete"
      )
    );
  }, [state, t]);
}

export function useEarnProgram() {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-program",
    () => fetchEarnProgramState(),
    {
      refreshInterval: earnProgramRefreshInterval,
      dedupingInterval: EARN_PROGRAM_DEDUPING_MS,
    }
  );
  return { state: data, error, isLoading, refresh: () => void mutate() };
}

export interface EarnProgramUpsertInput {
  /** Weights per token group, keyed to provider yield-source ids. */
  allocations: EarnPortfolioAllocationInput;
  label?: string;
  /**
   * Client-minted UUIDv4 so a retried confirm can neither provision a second
   * provider wallet nor apply the same strategy change twice. Must be re-minted
   * whenever `allocations` changes — the provider conflicts on a reused key with
   * a different payload.
   */
  requestId?: string;
}

export interface EarnProgramUpsertResult {
  program: EarnProgram;
  created: boolean;
}

/** Create the shared program wallet or replace its target allocation (idempotent PUT). */
export function upsertEarnProgram(
  input: EarnProgramUpsertInput
): Promise<DashboardFetchResult<{ data: EarnProgramUpsertResult }>> {
  return dashboardFetch("/api/dashboard/markets/earn/program", {
    method: "PUT",
    body: { provider: EARN_PORTFOLIO_PROVIDER, ...input },
  });
}

async function fetchEarnProgramDeposits(): Promise<EarnPortfolioDepositsPage> {
  const { status, body } = await requestJson<{ data: EarnPortfolioDepositsPage }>(
    `/api/dashboard/markets/earn/program/deposits?provider=${EARN_PORTFOLIO_PROVIDER}`
  );
  // No program wallet yet — an empty feed, not an error.
  if (status === 404) return { deposits: [], nextCursor: null };
  if (status < 200 || status >= 300 || !body) {
    throw new Error(errorMessage(body, status));
  }
  return body.data;
}

export function useEarnProgramDeposits(options: { enabled?: boolean } = {}) {
  const { data, error, isLoading } = useSWR(
    options.enabled === false ? null : "dashboard-earn-program-deposits",
    () => fetchEarnProgramDeposits(),
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
    // Stop on a short page as well as on the reported total: either one alone
    // can be wrong, and agreeing on "done" beats trusting one of them.
    if (body.data.strategies.length < STRATEGY_PAGE_SIZE || strategies.length >= body.data.total) {
      break;
    }
  }

  return strategies;
}

export function useEarnStrategies() {
  const { data, error, isLoading } = useSWR("dashboard-earn-strategies", () =>
    fetchEarnStrategies()
  );
  return { strategies: data, error, isLoading };
}

export interface EarnWithdrawalPreviewInput {
  amountUsd: string;
  token: EarnPortfolioToken;
}

export function previewEarnWithdrawal(
  input: EarnWithdrawalPreviewInput,
  signal?: AbortSignal
): Promise<DashboardFetchResult<{ data: { preview: EarnPortfolioWithdrawalPreview } }>> {
  return dashboardFetch("/api/dashboard/markets/earn/program/withdrawal-preview", {
    method: "POST",
    body: { provider: EARN_PORTFOLIO_PROVIDER, ...input },
    signal,
  });
}

export interface EarnWithdrawalCreateInput extends EarnWithdrawalPreviewInput {
  /** Client-minted UUIDv4 so a retried confirm can never double-withdraw. */
  requestId: string;
  destinationAddress: string;
}

export function createEarnWithdrawal(
  input: EarnWithdrawalCreateInput
): Promise<DashboardFetchResult<{ data: { withdrawal: EarnPortfolioWithdrawal } }>> {
  return dashboardFetch("/api/dashboard/markets/earn/program/withdrawals", {
    method: "POST",
    body: { provider: EARN_PORTFOLIO_PROVIDER, ...input },
  });
}

export function fetchEarnWithdrawal(
  withdrawalRef: string
): Promise<DashboardFetchResult<{ data: { withdrawal: EarnPortfolioWithdrawal } }>> {
  return dashboardFetch(
    `/api/dashboard/markets/earn/program/withdrawals/${encodeURIComponent(withdrawalRef)}?provider=${EARN_PORTFOLIO_PROVIDER}`
  );
}

/**
 * Statuses a withdrawal never moves on from. `pending_approval` is absent
 * deliberately: it is a WAIT, not an outcome — the payout is parked on a
 * customer signature and still resolves later — so watching continues.
 */
const SETTLED_WITHDRAWAL_STATUSES: ReadonlySet<EarnPortfolioWithdrawal["status"]> = new Set([
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

const WITHDRAWAL_OUTCOME_KEYS: Record<EarnPortfolioWithdrawal["status"], MessageKey> = {
  completed: "DashboardEarn.overview.withdrawalCompleted",
  partially_completed: "DashboardEarn.overview.withdrawalPartiallyCompleted",
  failed: "DashboardEarn.overview.withdrawalFailed",
  cancelled: "DashboardEarn.overview.withdrawalCancelled",
  pending_approval: "DashboardEarn.overview.withdrawalPendingApproval",
  processing: "DashboardEarn.overview.withdrawalProcessing",
};

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
 * resolves once someone signs), then announces once. Passing `undefined` — no
 * withdrawal submitted this session — does nothing and issues no requests.
 */
export function useEarnWithdrawalOutcomeToast(withdrawalRef: string | undefined): void {
  const t = useTranslations();
  const announced = useRef<string | undefined>(undefined);

  const { data } = useSWR(
    withdrawalRef ? ["dashboard-earn-withdrawal", withdrawalRef] : null,
    async () => {
      const result = await fetchEarnWithdrawal(withdrawalRef as string);
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
      return;
    }
    // Partial counts as a problem, not a success: some of the money did not
    // arrive, and saying "complete" would be the lie this hook exists to avoid.
    toast.error(message);
  }, [data, t]);
}
