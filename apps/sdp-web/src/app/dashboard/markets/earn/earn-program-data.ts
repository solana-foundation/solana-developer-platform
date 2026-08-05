"use client";

import type {
  EarnPortfolioAllocationInput,
  EarnPortfolioDepositsPage,
  EarnPortfolioToken,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalPreview,
  EarnPortfolioYield,
  EarnProviderId,
  EarnStrategy,
  ListEarnStrategiesResponse,
} from "@sdp/types";
import useSWR from "swr";
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

export interface UseEarnProgramOptions {
  /**
   * Poll while the shared wallet is still provisioning so screens waiting on
   * the deposit address (the funding step) advance without a manual refresh.
   */
  refreshWhileCreating?: boolean;
}

export function useEarnProgram(options: UseEarnProgramOptions = {}) {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-program",
    () => fetchEarnProgramState(),
    options.refreshWhileCreating
      ? {
          refreshInterval: (state) =>
            state?.kind === "active" && state.program.wallet.status === "creating" ? 4_000 : 0,
        }
      : undefined
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
