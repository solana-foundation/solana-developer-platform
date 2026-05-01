import type { CustodyConfigSummary, CustodyWalletSummary } from "@sdp/types";
import { NextResponse } from "next/server";
import { isKnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import {
  type FetchResult,
  fetchPaymentsAggregate,
} from "@/app/dashboard/payments/payments-page.data";
import {
  createDashboardWarmSnapshotSlice,
  DASHBOARD_WARM_SNAPSHOT_STALE_MS,
  type DashboardApiKeyEnvironment,
  type DashboardApiKeyRole,
  type DashboardApiKeyStatus,
  type DashboardApiKeyView,
  type DashboardIssuedTokenView,
  type DashboardWalletProviderStatus,
  type DashboardWarmSnapshot,
} from "@/lib/dashboard-warm-snapshot";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

const AGGREGATE_BALANCE_BUDGET_MS = 1_500;

interface OnboardingStatusResponse {
  linked: boolean;
  organization?: {
    id: string;
  } | null;
}

interface ApiKeysResponse {
  apiKeys?: Array<{
    id?: string;
    name?: string;
    keyPrefix?: string;
    role?: string;
    environment?: string;
    status?: string;
    lastUsedAt?: string | null;
    expiresAt?: string | null;
    createdAt?: string;
  }>;
}

interface CustodyConfigsResponse {
  configs?: CustodyConfigSummary[];
}

interface WarmSnapshotFetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };

    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body;
  }
}

function normalizeApiKeyRole(role: string | undefined): DashboardApiKeyRole {
  if (role === "api_admin" || role === "api_developer" || role === "api_readonly") {
    return role;
  }

  return "api_developer";
}

function normalizeApiKeyEnvironment(environment: string | undefined): DashboardApiKeyEnvironment {
  if (environment === "sandbox" || environment === "production") {
    return environment;
  }

  return "sandbox";
}

function normalizeApiKeyStatus(status: string | undefined): DashboardApiKeyStatus {
  if (
    status === "active" ||
    status === "revoked" ||
    status === "expired" ||
    status === "deactivated"
  ) {
    return status;
  }

  return "active";
}

function timeoutResult<T>(error: string): Promise<FetchResult<T>> {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => {
      resolve({
        ok: false,
        error,
      });
    }, AGGREGATE_BALANCE_BUDGET_MS);
  });
}

async function fetchWithAggregateBudget<T>(promise: Promise<FetchResult<T>>) {
  return Promise.race([promise, timeoutResult<T>("Aggregate balance is refreshing.")]);
}

async function fetchApiKeys(
  request: SdpApiClient["request"]
): Promise<WarmSnapshotFetchResult<DashboardApiKeyView[]>> {
  try {
    const response = await request("/v1/api-keys");
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: ApiKeysResponse;
    };
    const apiKeys = (json.data?.apiKeys ?? [])
      .filter((apiKey): apiKey is NonNullable<typeof apiKey> => Boolean(apiKey?.id))
      .map((apiKey) => ({
        id: apiKey.id ?? "",
        name: apiKey.name ?? "Unnamed key",
        keyPrefix: apiKey.keyPrefix ?? "sdp_...",
        role: normalizeApiKeyRole(apiKey.role),
        environment: normalizeApiKeyEnvironment(apiKey.environment),
        status: normalizeApiKeyStatus(apiKey.status),
        lastUsedAt: apiKey.lastUsedAt ?? null,
        expiresAt: apiKey.expiresAt ?? null,
        createdAt: apiKey.createdAt ?? "",
      }));

    return { ok: true, data: apiKeys };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load API keys",
    };
  }
}

async function fetchWalletSummaries(
  request: SdpApiClient["request"]
): Promise<WarmSnapshotFetchResult<CustodyWalletSummary[]>> {
  try {
    const query = new URLSearchParams({
      includeAllProviders: "true",
      includeBalances: "true",
      view: "summary",
    }).toString();
    const response = await request(`/v1/wallets?${query}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: {
        wallets?: CustodyWalletSummary[];
      };
    };

    return { ok: true, data: json.data?.wallets ?? [] };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load wallets",
    };
  }
}

async function fetchIssuedTokens(
  request: SdpApiClient["request"]
): Promise<WarmSnapshotFetchResult<DashboardIssuedTokenView[]>> {
  try {
    const tokensPath = `/v1/issuance/tokens?${new URLSearchParams({
      page: "1",
      pageSize: "100",
    }).toString()}`;
    const response = await request(tokensPath);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        symbol?: string;
        status?: string;
        template?: string;
        imageUrl?: string | null;
        mintAddress?: string | null;
        totalSupply?: string;
        createdAt?: string;
        deployedAt?: string | null;
      }>;
    };
    const tokens = (json.data ?? [])
      .filter((token): token is NonNullable<typeof token> => Boolean(token?.id))
      .map((token) => ({
        id: token.id ?? "",
        name: token.name ?? "Untitled token",
        symbol: token.symbol ?? "-",
        status: token.status ?? "pending",
        template: token.template ?? "custom",
        imageUrl: token.imageUrl ?? null,
        mintAddress: token.mintAddress ?? null,
        totalSupply: token.totalSupply ?? "0",
        createdAt: token.createdAt ?? "",
        deployedAt: token.deployedAt ?? null,
      }));

    return { ok: true, data: tokens };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load tokens",
    };
  }
}

async function fetchWalletProviderStatus(
  apiClient: SdpApiClient
): Promise<WarmSnapshotFetchResult<DashboardWalletProviderStatus>> {
  try {
    const [onboarding, configsResponse] = await Promise.all([
      apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status"),
      apiClient.request("/v1/wallets/configs"),
    ]);

    if (!onboarding.linked) {
      return {
        ok: true,
        data: {
          connectedProviders: [],
          enabledProviders: [],
          configsError: null,
        },
      };
    }

    let configs: CustodyConfigSummary[] = [];
    let configsError: string | null = null;

    if (configsResponse.status === 404) {
      configs = [];
    } else if (!configsResponse.ok) {
      const body = await configsResponse.text();
      configsError = parseErrorMessage(body) || "Unable to load wallet providers";
    } else {
      const parsed = (await configsResponse.json()) as { data?: CustodyConfigsResponse };
      configs = parsed.data?.configs ?? [];
    }

    const connectedProviders = configs
      .filter((config) => config.status === "active")
      .map((config) => config.provider)
      .filter(isKnownCustodyProvider);
    const providerAvailability =
      onboarding.organization?.id && configsError === null
        ? await fetchProviderAvailability(apiClient.request, onboarding.organization.id)
        : null;

    return {
      ok: true,
      data: {
        connectedProviders,
        enabledProviders: providerAvailability?.enabledCustodyProviders ?? connectedProviders,
        configsError,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load wallet provider status",
    };
  }
}

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.warm_snapshot", request);
  const generatedAt = new Date();
  const generatedAtIso = generatedAt.toISOString();
  const staleAtIso = new Date(
    generatedAt.getTime() + DASHBOARD_WARM_SNAPSHOT_STALE_MS
  ).toISOString();

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.warm_snapshot.api")
    );
    const [walletsResult, aggregateResult, issuedTokensResult, apiKeysResult, providersResult] =
      await Promise.all([
        fetchWalletSummaries(apiClient.request),
        fetchWithAggregateBudget(fetchPaymentsAggregate(apiClient.request)),
        fetchIssuedTokens(apiClient.request),
        fetchApiKeys(apiClient.request),
        fetchWalletProviderStatus(apiClient),
      ]);
    const aggregateTimedOut = aggregateResult.error === "Aggregate balance is refreshing.";
    const snapshot: DashboardWarmSnapshot = {
      generatedAt: generatedAtIso,
      staleAt: staleAtIso,
      wallets: createDashboardWarmSnapshotSlice({
        data: walletsResult.data ?? [],
        error: walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets"),
        generatedAt: generatedAtIso,
        staleAt: staleAtIso,
      }),
      aggregateBalance: createDashboardWarmSnapshotSlice({
        data: aggregateResult.data ?? null,
        error: aggregateResult.ok
          ? null
          : (aggregateResult.error ?? "Unable to load aggregate balances"),
        generatedAt: generatedAtIso,
        staleAt: staleAtIso,
        status: aggregateTimedOut ? "refreshing" : undefined,
      }),
      issuedTokens: createDashboardWarmSnapshotSlice({
        data: issuedTokensResult.data ?? [],
        error: issuedTokensResult.ok
          ? null
          : (issuedTokensResult.error ?? "Unable to load issued tokens"),
        generatedAt: generatedAtIso,
        staleAt: staleAtIso,
      }),
      apiKeys: createDashboardWarmSnapshotSlice({
        data: apiKeysResult.data ?? [],
        error: apiKeysResult.ok ? null : (apiKeysResult.error ?? "Unable to load API keys"),
        generatedAt: generatedAtIso,
        staleAt: staleAtIso,
      }),
      walletProviderStatus: createDashboardWarmSnapshotSlice({
        data: providersResult.data ?? {
          connectedProviders: [],
          enabledProviders: [],
          configsError: providersResult.error ?? "Unable to load wallet providers",
        },
        error: providersResult.ok
          ? (providersResult.data?.configsError ?? null)
          : (providersResult.error ?? "Unable to load wallet providers"),
        generatedAt: generatedAtIso,
        staleAt: staleAtIso,
      }),
    };

    const response = NextResponse.json(
      {
        data: {
          snapshot,
        },
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, 200, {
      apiKeyCount: snapshot.apiKeys.data.length,
      hasAggregate: Boolean(snapshot.aggregateBalance.data),
      tokenCount: snapshot.issuedTokens.data.length,
      walletCount: snapshot.wallets.data.length,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Failed to build dashboard snapshot",
        },
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to build dashboard snapshot",
    });
    return response;
  }
}
