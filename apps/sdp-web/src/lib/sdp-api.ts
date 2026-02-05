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
  const token = template
    ? await getToken({ template, organizationId: orgId })
    : await getToken({ organizationId: orgId });

  if (!token) {
    throw new Error("Failed to acquire Clerk token");
  }

  return token;
}

export async function sdpApiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getClerkToken();
  const url = `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return (await res.json()) as T;
}
