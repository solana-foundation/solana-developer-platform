import type { SdpApiClient } from "@/lib/sdp-api";

export interface PlaygroundApiKeyView {
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

export function resolvePlaygroundApiBaseUrl(): string | null {
  const baseUrl =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "";

  return baseUrl.replace(/\/$/, "") || null;
}

export async function fetchActiveApiKeys(
  request: SdpApiClient["request"]
): Promise<FetchResult<PlaygroundApiKeyView[]>> {
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
