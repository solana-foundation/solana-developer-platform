"use server";

import type { SafeRpcConnection } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { updateOrganizationRpcSettingsAction } from "@/app/dashboard/settings/actions";
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
  const scope = String(formData.get("scope") ?? "project").trim();
  const credentialLabel = String(formData.get("credentialLabel") ?? "").trim();
  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "");

  // Trimmed-empty passes the browser's `required` check but is a known reject.
  // The endpoint is deliberately absent: providers that publish one host for
  // every account resolve it server-side, and only the rest are asked for it.
  if (!provider || !credentialLabel || !apiKey.trim()) {
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

/**
 * Switch this project onto a provider, both halves of it.
 *
 * Choosing a provider and choosing whose credentials answer for it were two
 * separate controls, and the credential always won. So pressing "Use this
 * provider" wrote a setting the relay never reached: the page named the new
 * provider, the old one kept answering, and the button looked broken.
 *
 * The credential goes first on purpose. It is the half that can be refused --
 * an organization running only on its own keys cannot move to a provider it
 * holds no key for -- and failing there must leave the selection as it was
 * rather than pointing at a provider that is not serving.
 */
export async function switchRpcProviderAction(
  formData: FormData
): Promise<
  | { status: "success"; provider: string; usesOwnCredential: boolean }
  | { status: "error"; message: string }
> {
  const provider = String(formData.get("provider") ?? "").trim();
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  if (!provider || !organizationId) {
    return { status: "error", message: "A provider is required." };
  }

  let usesOwnCredential = false;
  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{
      servingProvider: string | null;
      usesOwnCredential: boolean;
    }>("/internal/dashboard/rpc/serving-provider", {
      method: "PUT",
      body: JSON.stringify({ provider }),
    });
    usesOwnCredential = result.usesOwnCredential;
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }

  // The selection still decides what answers once a tenant connection is gone,
  // so it is written even when a key of their own is what serves today.
  const settings = new FormData();
  settings.set("organizationId", organizationId);
  settings.set("rpcProvider", provider);
  const saved = await updateOrganizationRpcSettingsAction(settings);
  if (saved.status !== "success") {
    return { status: "error", message: saved.message };
  }

  revalidateProvider(provider);
  return { status: "success", provider, usesOwnCredential };
}

/**
 * Move the organization between SDP-managed RPC and running entirely on its
 * own credentials. Organization-wide, so it revalidates the whole section
 * rather than one provider's rows.
 */
export async function setRpcCredentialModeAction(
  formData: FormData
): Promise<{ status: "saved"; mode: string } | { status: "error"; message: string }> {
  const mode = String(formData.get("mode") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  if (mode !== "managed" && mode !== "byok") {
    return { status: "error", message: "Pick a credential mode." };
  }

  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{ mode: string }>("/internal/dashboard/rpc/credential-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
    revalidateProvider(provider);
    return { status: "saved", mode: result.mode };
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }
}

/**
 * Replace the key behind a connection (HOO-1229). The old key stays in place
 * until the new one has been checked, so a rejected key changes nothing.
 */
export async function rotateRpcConnectionAction(
  formData: FormData
): Promise<RpcConnectionActionResult> {
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "");

  if (!connectionId || !apiKey.trim()) {
    return { status: "invalid", message: "A new API key is required." };
  }

  try {
    const client = await createSdpApiClient();
    const connection = await client.fetch<SafeRpcConnection>(
      `/internal/dashboard/rpc/connections/${encodeURIComponent(connectionId)}/rotate`,
      {
        method: "POST",
        body: JSON.stringify({
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

/**
 * Check a stored connection on demand (HOO-1228). Nothing is persisted, so the
 * answer is only ever as old as the click that asked for it.
 */
export async function testRpcConnectionAction(
  formData: FormData
): Promise<
  | { status: "tested"; ok: boolean; failureCode: string | null }
  | { status: "error"; message: string }
> {
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  if (!connectionId) {
    return { status: "error", message: "A connection is required." };
  }

  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{ ok: boolean; failureCode: string | null }>(
      `/internal/dashboard/rpc/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST" }
    );
    return { status: "tested", ok: result.ok, failureCode: result.failureCode };
  } catch (error) {
    return { status: "error", message: extractApiMessage(error) };
  }
}

/**
 * Clear a deactivated connection out of the list (HOO-1219). Nothing comes
 * back but the outcome, so the result carries no connection.
 */
export async function deleteRpcConnectionAction(
  formData: FormData
): Promise<RpcConnectionActionResult | { status: "deleted" }> {
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  if (!connectionId) {
    return { status: "invalid", message: "A connection is required." };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch(`/internal/dashboard/rpc/connections/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    });
    revalidateProvider(provider);
    return { status: "deleted" };
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
