"use server";

import { createSdpApiClient, extractSdpApiError } from "@/lib/sdp-api";

export interface FireblocksCsr {
  id: string;
  csrPem: string;
  expiresAt: string;
}
export type FireblocksCsrResult =
  | { status: "success"; csr: FireblocksCsr | null }
  | { status: "error"; message: string };

export async function loadFireblocksCsrAction(): Promise<FireblocksCsrResult> {
  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{ csr: FireblocksCsr | null }>(
      "/internal/dashboard/custody/fireblocks/csr"
    );
    return { status: "success", csr: result.csr };
  } catch {
    return { status: "error", message: "Could not load Fireblocks registration. Try again." };
  }
}

export async function generateFireblocksCsrAction(
  idempotencyKey: string
): Promise<FireblocksCsrResult> {
  if (!/^[a-f0-9-]{36}$/.test(idempotencyKey))
    return { status: "error", message: "Invalid registration request." };
  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{ csr: FireblocksCsr }>(
      "/internal/dashboard/custody/fireblocks/csr",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({}),
      }
    );
    return { status: "success", csr: result.csr };
  } catch (error) {
    const { message } = extractSdpApiError(error);
    return { status: "error", message: message || "Could not generate your CSR. Try again." };
  }
}

export interface FireblocksVault {
  id: string;
  name: string;
  hasSolanaWallet: boolean;
}
export async function loadFireblocksVaultsAction(input: {
  signingKeyId: string;
  apiKey: string;
  after?: string;
}): Promise<
  | { status: "success"; vaults: FireblocksVault[]; nextCursor: string | null }
  | { status: "error"; message: string }
> {
  try {
    const client = await createSdpApiClient();
    const result = await client.fetch<{ vaults: FireblocksVault[]; nextCursor: string | null }>(
      "/internal/dashboard/custody/fireblocks/vaults",
      { method: "POST", body: JSON.stringify(input) }
    );
    return { status: "success", ...result };
  } catch (error) {
    const { message } = extractSdpApiError(error);
    return { status: "error", message: message || "Could not load Fireblocks vaults. Try again." };
  }
}
