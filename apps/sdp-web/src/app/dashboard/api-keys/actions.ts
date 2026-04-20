"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sdpApiFetch } from "@/lib/sdp-api";
import { API_KEY_FLASH_COOKIE, API_KEYS_PAGE_PATH, type ApiKeyFlash } from "./api-key-flash";

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function setFlash(flash: ApiKeyFlash) {
  const jar = await cookies();
  jar.set(API_KEY_FLASH_COOKIE, JSON.stringify(flash), {
    httpOnly: true,
    sameSite: "lax",
    path: API_KEYS_PAGE_PATH,
    maxAge: 60 * 5,
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function normalizeDeactivateApiKeyInput(input: {
  keyId: string;
  keyName: string;
  confirmation: string;
}): {
  keyId: string;
  keyName: string;
  confirmation: string;
} {
  return {
    keyId: input.keyId.trim(),
    keyName: input.keyName.trim(),
    confirmation: input.confirmation.trim(),
  };
}

async function deactivateApiKeyRequest(input: {
  keyId: string;
  keyName: string;
  confirmation: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const { keyId, keyName, confirmation } = normalizeDeactivateApiKeyInput(input);

  if (!keyId) {
    return {
      ok: false,
      message: "Missing API key id for deletion.",
    };
  }

  if (!keyName) {
    return {
      ok: false,
      message: "Missing API key name for deletion confirmation.",
    };
  }

  if (!confirmation) {
    return {
      ok: false,
      message: "Type the key name to confirm API key deletion.",
    };
  }

  if (confirmation !== keyName) {
    return {
      ok: false,
      message: "Confirmation did not match the key name.",
    };
  }

  try {
    await sdpApiFetch(`/v1/api-keys/${keyId}`, {
      method: "DELETE",
      body: JSON.stringify({
        confirmation,
      }),
    });

    return {
      ok: true,
      message: `API key "${keyName}" has been deactivated.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Delete failed: ${extractErrorMessage(error)}`,
    };
  }
}

export async function createApiKeyAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "api_developer");
  const environment = String(formData.get("environment") ?? "sandbox");
  const walletScope = String(formData.get("walletScope") ?? "").trim();
  const defaultWalletId = String(formData.get("signingWalletId") ?? "").trim();
  const signingWalletIds = formData
    .getAll("signingWalletIds")
    .map((value) => String(value).trim())
    .filter(Boolean);
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();

  if (!name) {
    await setFlash({
      level: "error",
      message: "API key name is required.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  if (walletScope !== "all" && walletScope !== "selected") {
    await setFlash({
      level: "error",
      message: "Choose whether this key can access all wallets or selected wallets.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  if (walletScope === "selected" && signingWalletIds.length === 0) {
    await setFlash({
      level: "error",
      message: "Select at least one wallet for a wallet-scoped API key.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  const payload: {
    name: string;
    role: "api_admin" | "api_developer" | "api_readonly";
    environment: "sandbox" | "production";
    walletScope: "all" | "selected";
    expiresAt?: string;
    signingWalletId?: string;
    signingWalletIds?: string[];
  } = {
    name,
    role:
      role === "api_admin" || role === "api_readonly" || role === "api_developer"
        ? role
        : "api_developer",
    environment: environment === "production" ? "production" : "sandbox",
    walletScope: walletScope === "selected" ? "selected" : "all",
  };

  if (walletScope === "selected") {
    payload.signingWalletIds = signingWalletIds;
    payload.signingWalletId = defaultWalletId || signingWalletIds[0];
  }

  if (expiresAtRaw) {
    const parsedDate = new Date(expiresAtRaw);
    if (Number.isNaN(parsedDate.getTime())) {
      await setFlash({
        level: "error",
        message: "Invalid expiration date.",
      });
      redirect(API_KEYS_PAGE_PATH);
    }
    payload.expiresAt = parsedDate.toISOString();
  }

  try {
    const response = await sdpApiFetch<{
      apiKey: {
        id: string;
        name: string;
        key: string;
        keyPrefix: string;
      };
    }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    await setFlash({
      level: "success",
      message: `API key "${response.apiKey.name}" created. Save it now; it will not be shown again.`,
      key: response.apiKey.key,
      apiKeyId: response.apiKey.id,
      keyPrefix: response.apiKey.keyPrefix,
    });
  } catch (error) {
    await setFlash({
      level: "error",
      message: `Create failed: ${extractErrorMessage(error)}`,
    });
  }

  revalidatePath(API_KEYS_PAGE_PATH, "page");
  redirect(API_KEYS_PAGE_PATH);
}

export async function rotateApiKeyAction(formData: FormData) {
  const keyId = String(formData.get("keyId") ?? "").trim();
  const gracePeriodHours = Math.min(168, Math.max(0, parsePositiveInt(formData.get("grace"), 24)));

  if (!keyId) {
    await setFlash({
      level: "error",
      message: "Missing API key id for rotation.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  try {
    const response = await sdpApiFetch<{
      apiKey: {
        id: string;
        name: string;
        key: string;
        keyPrefix: string;
      };
      previousKey: {
        id: string;
        rotationDeadline: string;
      };
    }>(`/v1/api-keys/${keyId}/rotate`, {
      method: "POST",
      body: JSON.stringify({ gracePeriodHours }),
    });

    await setFlash({
      level: "success",
      message: `API key rotated. Previous key remains valid until ${new Date(response.previousKey.rotationDeadline).toLocaleString()}.`,
      key: response.apiKey.key,
      apiKeyId: response.apiKey.id,
      keyPrefix: response.apiKey.keyPrefix,
    });
  } catch (error) {
    await setFlash({
      level: "error",
      message: `Rotate failed: ${extractErrorMessage(error)}`,
    });
  }

  revalidatePath(API_KEYS_PAGE_PATH, "page");
  redirect(API_KEYS_PAGE_PATH);
}

export async function deactivateApiKeyAction(formData: FormData) {
  const result = await deactivateApiKeyRequest({
    keyId: String(formData.get("keyId") ?? ""),
    keyName: String(formData.get("keyName") ?? ""),
    confirmation: String(formData.get("confirmation") ?? ""),
  });

  await setFlash({
    level: result.ok ? "success" : "error",
    message: result.message,
  });

  revalidatePath(API_KEYS_PAGE_PATH, "page");
  redirect(API_KEYS_PAGE_PATH);
}

export async function deactivateApiKeyInlineAction(input: {
  keyId: string;
  keyName: string;
  confirmation: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const result = await deactivateApiKeyRequest(input);
  if (result.ok) {
    revalidatePath(API_KEYS_PAGE_PATH, "page");
  }

  return result;
}
