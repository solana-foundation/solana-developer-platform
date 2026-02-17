import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { IssuanceWorkspace } from "./issuance-workspace";
import { issuanceTemplateCatalog } from "./template-catalog";

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
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

interface IssuanceApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface FetchResult<T> {
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

async function fetchTemplates(request: SdpApiClient["request"]): Promise<FetchResult<IssuanceTemplateView[]>> {
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

async function fetchTokens(request: SdpApiClient["request"]): Promise<FetchResult<IssuanceTokenView[]>> {
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

async function fetchApiKeys(request: SdpApiClient["request"]): Promise<FetchResult<IssuanceApiKeyView[]>> {
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
      data?: {
        apiKeys?: Array<{
          id?: string;
          name?: string;
          keyPrefix?: string;
          role?: string;
          environment?: string;
          status?: string;
        }>;
      };
    };

    const apiKeys = (json?.data?.apiKeys ?? [])
      .filter((apiKey): apiKey is NonNullable<typeof apiKey> => Boolean(apiKey?.id))
      .filter((apiKey) => apiKey.status === "active")
      .map((apiKey) => ({
        id: apiKey.id ?? "",
        name: apiKey.name ?? "Unnamed key",
        keyPrefix: apiKey.keyPrefix ?? "sdp_...",
        role: apiKey.role ?? "api_developer",
        environment: apiKey.environment ?? "sandbox",
      }));

    return { ok: true, data: apiKeys };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load API keys",
    };
  }
}

export default async function IssuancePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const [templatesResult, tokensResult, apiKeysResult] = await Promise.all([
    fetchTemplates(apiClient.request),
    fetchTokens(apiClient.request),
    fetchApiKeys(apiClient.request),
  ]);

  const templates =
    templatesResult.data && templatesResult.data.length > 0
      ? templatesResult.data
      : issuanceTemplateCatalog.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
        }));

  const tokens = tokensResult.data ?? [];
  const apiKeys = apiKeysResult.data ?? [];
  const templatesError = templatesResult.ok
    ? null
    : `Template API ${templatesResult.status ?? "unavailable"}: ${templatesResult.error ?? "Unknown error"}`;
  const tokensError = tokensResult.ok
    ? null
    : `Token API ${tokensResult.status ?? "unavailable"}: ${tokensResult.error ?? "Unknown error"}`;

  return (
    <IssuanceWorkspace
      templates={templates}
      tokens={tokens}
      apiKeys={apiKeys}
      templatesError={templatesError}
      tokensError={tokensError}
    />
  );
}
