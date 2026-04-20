import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { IssuanceWorkspace } from "./issuance-workspace";

interface IssuanceTemplateView {
  id: string;
  name: string;
  description?: string;
}

interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

interface FetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function resolveTokenListNotice(result: FetchResult<IssuanceTokenView[]>): string | null {
  if (result.ok) {
    return null;
  }

  if (typeof result.status === "number" && result.status >= 400 && result.status < 500) {
    return "We couldn't load the token list right now. Refresh the page to try again.";
  }

  return "We couldn't load the token list right now. You can still create a token or try again shortly.";
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

async function fetchTemplates(
  request: SdpApiClient["request"]
): Promise<FetchResult<IssuanceTemplateView[]>> {
  try {
    const response = await request("/v1/issuance/templates");
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
        templates?: Array<{ id?: string; name?: string; description?: string }>;
      };
    };

    const templates = (json?.data?.templates ?? [])
      .filter((entry): entry is { id: string; name: string; description?: string } => {
        return typeof entry.id === "string" && typeof entry.name === "string";
      })
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
      }));

    return { ok: true, data: templates };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load templates",
    };
  }
}

async function fetchTokens(
  request: SdpApiClient["request"]
): Promise<FetchResult<IssuanceTokenView[]>> {
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

    const tokens = (json?.data ?? [])
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

interface IssuancePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function IssuancePage({ searchParams }: IssuancePageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.issuance.page");

  try {
    const resolvedSearchParams = searchParams ? await searchParams : undefined;
    const currentTab =
      resolvedSearchParams?.tab === "playground" ||
      (Array.isArray(resolvedSearchParams?.tab) && resolvedSearchParams.tab[0] === "playground")
        ? "playground"
        : "tokens";
    const apiBaseUrl = resolvePlaygroundApiBaseUrl();
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.issuance.api"))
    );
    const [templatesResult, tokensResult, apiKeysResult, signerWalletsResult] = await Promise.all([
      trace.step("fetch_templates", () => fetchTemplates(apiClient.request)),
      trace.step("fetch_tokens", () => fetchTokens(apiClient.request)),
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
      trace.step("fetch_signer_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary" })
      ),
    ]);

    const tokens = tokensResult.data ?? [];
    const apiKeys = apiKeysResult.data ?? [];
    const templatesError = templatesResult.ok
      ? null
      : `Template API ${templatesResult.status ?? "unavailable"}: ${templatesResult.error ?? "Unknown error"}`;

    trace.log({
      ok: true,
      tab: currentTab,
      tokenCount: tokens.length,
      templateCount: templatesResult.data?.length ?? 0,
      apiKeyCount: apiKeys.length,
      signerWalletCount: signerWalletsResult.data?.length ?? 0,
    });

    return (
      <IssuanceWorkspace
        tokens={tokens}
        templates={templatesResult.data ?? []}
        apiKeys={apiKeys}
        signerWallets={signerWalletsResult.data ?? []}
        apiBaseUrl={apiBaseUrl}
        templatesError={templatesError}
        tokensNotice={resolveTokenListNotice(tokensResult)}
        signerWalletsError={
          signerWalletsResult.ok
            ? null
            : `Wallet API ${signerWalletsResult.status ?? "unavailable"}: ${signerWalletsResult.error ?? "Unknown error"}`
        }
      />
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
