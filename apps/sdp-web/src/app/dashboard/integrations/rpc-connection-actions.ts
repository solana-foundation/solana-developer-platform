"use server";

import type { SafeRpcConnection } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { createSdpApiClient } from "@/lib/sdp-api";

/**
 * Tenant-owned RPC credentials (HOO-1090), reaching the dashboard-only routes
 * the same way the Privy custody flow does: server actions over
 * `/internal/dashboard/*`, never a browser-visible proxy. The API refuses API
 * keys on these routes, so a signed-in session is the only way in.
 *
 * `apiKey` travels one way. Nothing here ever returns it, and the API's
 * response type has no field that could carry it back.
 */
export type RpcConnectionActionResult =
  | { status: "success"; connection: SafeRpcConnection }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

function extractApiMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    return raw;
  }
  const body = match[2] ?? "";
  try {
    const json = JSON.parse(body) as { error?: { message?: string } };
    return json.error?.message ?? body;
  } catch {
    return body;
  }
}

function revalidateProvider(provider: string) {
  revalidatePath(`/dashboard/integrations/${provider}`);
  revalidatePath("/dashboard/integrations");
}

export async function submitRpcConnectionAction(
  formData: FormData
): Promise<RpcConnectionActionResult> {
  const provider = String(formData.get("provider") ?? "").trim();
  const network = String(formData.get("network") ?? "").trim();
  const scope = String(formData.get("scope") ?? "organization").trim();
  const credentialLabel = String(formData.get("credentialLabel") ?? "").trim();
  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "");

  // Trimmed-empty passes the browser's `required` check but is a known reject.
  // The endpoint is deliberately absent: providers that publish one host for
  // every account resolve it server-side, and only the rest are asked for it.
  if (!provider || !network || !credentialLabel || !apiKey.trim()) {
    return { status: "invalid", message: "A name and an API key are required." };
  }

  try {
    const client = await createSdpApiClient();
    const connection = await client.fetch<SafeRpcConnection>(
      "/internal/dashboard/rpc/connections",
      {
        method: "POST",
        body: JSON.stringify({
          provider,
          network,
          scope,
          credentialLabel,
          // Omitted, not empty: the API validates this as a URL when present.
          ...(endpointUrl ? { endpointUrl } : {}),
          apiKey,
        }),
      }
    );
    revalidateProvider(provider);
    return { status: "success", connection };
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }
}

export async function activateRpcConnectionAction(
  formData: FormData
): Promise<RpcConnectionActionResult> {
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  if (!connectionId) {
    return { status: "invalid", message: "A connection is required." };
  }

  try {
    const client = await createSdpApiClient();
    const connection = await client.fetch<SafeRpcConnection>(
      `/internal/dashboard/rpc/connections/${encodeURIComponent(connectionId)}/activate`,
      { method: "POST", body: JSON.stringify({ makeDefault: true }) }
    );
    revalidateProvider(provider);
    return { status: "success", connection };
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }
}

export async function deactivateRpcConnectionAction(
  formData: FormData
): Promise<RpcConnectionActionResult> {
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  if (!connectionId) {
    return { status: "invalid", message: "A connection is required." };
  }

  try {
    const client = await createSdpApiClient();
    const connection = await client.fetch<SafeRpcConnection>(
      `/internal/dashboard/rpc/connections/${encodeURIComponent(connectionId)}/deactivate`,
      { method: "POST" }
    );
    revalidateProvider(provider);
    return { status: "success", connection };
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }
}
