import { PageBody, PageHeader, PageLayout } from "@/components/layouts";
import { type SdpApiClient, createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import type { FrozenAccount, Token, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { TokenManagementWorkspace } from "./token-management-workspace";

interface TokenManagementPageProps {
  params: Promise<{
    tokenId: string;
  }>;
}

interface FetchResult<T> {
  status: number | null;
  data: T | null;
  error: string | null;
  total: number | null;
  hasMore: boolean;
}

interface PaginatedMeta {
  total?: number;
  hasMore?: boolean;
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body || "Unknown error";
  }
}

async function fetchData<T>(
  request: SdpApiClient["request"],
  path: string,
  map: (payload: unknown) => T
): Promise<FetchResult<T>> {
  try {
    const response = await request(path);
    if (!response.ok) {
      const body = await response.text();
      return {
        status: response.status,
        data: null,
        error: parseErrorMessage(body),
        total: null,
        hasMore: false,
      };
    }

    const payload = (await response.json()) as {
      data?: unknown;
      meta?: PaginatedMeta;
    };

    return {
      status: response.status,
      data: map(payload?.data),
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : null,
      hasMore: payload.meta?.hasMore === true,
    };
  } catch (error) {
    return {
      status: null,
      data: null,
      error: error instanceof Error ? error.message : "Request failed",
      total: null,
      hasMore: false,
    };
  }
}

function mapToken(payload: unknown): Token | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const token = (payload as { token?: Token }).token;
  return token ?? null;
}

function mapList<T>(payload: unknown): T[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload as T[];
}

export default async function IssuanceTokenManagementPage({ params }: TokenManagementPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { tokenId } = await params;
  const apiClient = await createSdpApiClient();

  const [tokenResult, walletsResult, transactionsResult, allowlistResult, frozenResult] =
    await Promise.all([
      fetchData<Token | null>(apiClient.request, `/v1/issuance/tokens/${tokenId}`, mapToken),
      fetchPaymentsWallets(apiClient.request),
      fetchData<TokenTransaction[]>(
        apiClient.request,
        `/v1/issuance/tokens/${tokenId}/transactions?page=1&pageSize=100`,
        (payload) => mapList<TokenTransaction>(payload)
      ),
      fetchData<TokenAllowlistEntry[]>(
        apiClient.request,
        `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=100`,
        (payload) => mapList<TokenAllowlistEntry>(payload)
      ),
      fetchData<FrozenAccount[]>(
        apiClient.request,
        `/v1/issuance/tokens/${tokenId}/frozen?page=1&pageSize=100`,
        (payload) => mapList<FrozenAccount>(payload)
      ),
    ]);

  if (tokenResult.status === 404 || !tokenResult.data) {
    notFound();
  }

  return (
    <PageLayout width="full">
      <PageHeader
        variant="narrow"
        backLink={{ href: "/dashboard/issuance", label: "Back to overview" }}
      />
      <PageBody>
        <TokenManagementWorkspace
          token={tokenResult.data}
          tokenError={
            tokenResult.error
              ? `Token API ${tokenResult.status ?? "unavailable"}: ${tokenResult.error}`
              : null
          }
          authorityWallets={walletsResult.ok ? (walletsResult.data ?? []) : []}
          authorityWalletsError={
            walletsResult.ok ? null : (walletsResult.error ?? "Wallets unavailable")
          }
          transactions={transactionsResult.data ?? []}
          transactionsError={
            transactionsResult.error
              ? `Transactions API ${transactionsResult.status ?? "unavailable"}: ${transactionsResult.error}`
              : null
          }
          transactionsTotal={transactionsResult.total}
          transactionsHasMore={transactionsResult.hasMore}
          allowlistEntries={allowlistResult.data ?? []}
          allowlistError={
            allowlistResult.error
              ? `Allowlist API ${allowlistResult.status ?? "unavailable"}: ${allowlistResult.error}`
              : null
          }
          allowlistTotal={allowlistResult.total}
          allowlistHasMore={allowlistResult.hasMore}
          frozenAccounts={frozenResult.data ?? []}
          frozenAccountsError={
            frozenResult.error
              ? `Frozen API ${frozenResult.status ?? "unavailable"}: ${frozenResult.error}`
              : null
          }
          frozenAccountsTotal={frozenResult.total}
          frozenAccountsHasMore={frozenResult.hasMore}
        />
      </PageBody>
    </PageLayout>
  );
}
