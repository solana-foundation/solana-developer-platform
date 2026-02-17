import { auth } from "@clerk/nextjs/server";

function getApiBaseUrl(): string {
  const base =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL;

  if (!base) {
    throw new Error("SDP_API_BASE_URL is not configured");
  }

  return base.replace(/\/$/, "");
}

async function getClerkToken(): Promise<string> {
  const { getToken, orgId } = await auth();
  if (!orgId) {
    throw new Error("Active Clerk organization required");
  }

  const template = process.env.CLERK_JWT_TEMPLATE;
  let token: string | null = null;
  let templateError: unknown;

  if (template) {
    try {
      token = await getToken({ template });
    } catch (error) {
      templateError = error;
    }
  }

  if (!token) {
    try {
      token = await getToken();
    } catch (error) {
      if (templateError) {
        throw templateError;
      }
      throw error;
    }
  }

  if (!token) {
    throw new Error("Failed to acquire Clerk token");
  }

  return token;
}

type SdpApiRequestFn = (path: string, options?: RequestInit) => Promise<Response>;

function createSdpApiRequest(token: string): SdpApiRequestFn {
  return async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;

    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
  };
}

async function parseSdpApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  if (res.status === 204) {
    return {} as T;
  }

  const json = (await res.json()) as unknown;

  if (json && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }

  return json as T;
}

export interface SdpApiClient {
  request: SdpApiRequestFn;
  fetch: <T>(path: string, options?: RequestInit) => Promise<T>;
}

export async function createSdpApiClient(): Promise<SdpApiClient> {
  const token = await getClerkToken();
  const request = createSdpApiRequest(token);

  return {
    request,
    fetch: async <T>(path: string, options: RequestInit = {}): Promise<T> => {
      const res = await request(path, options);
      return parseSdpApiResponse<T>(res);
    },
  };
}

export async function sdpApiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const client = await createSdpApiClient();
  return client.request(path, options);
}

export async function sdpApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const client = await createSdpApiClient();
  const res = await client.request(path, options);
  return parseSdpApiResponse<T>(res);
}
