"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { createSdpApiClient, requestProjectHref, requestProjectId } from "@/lib/sdp-api";
import {
  type ApiKeyAuthoringDraft,
  type ApiKeyAuthoringMode,
  buildAllowedOperations,
  buildEndpointWalletPayload,
} from "./api-key-authoring";
import {
  API_KEY_FLASH_COOKIE,
  API_KEYS_PAGE_PATH,
  type ApiKeyFlash,
  apiKeyFlashCookieOptions,
  apiKeyFlashMaxAgeSeconds,
} from "./api-key-flash";
import { sealApiKeyFlash } from "./api-key-flash-seal";

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function setFlash(flash: ApiKeyFlash) {
  // The flash can carry a freshly generated API key secret, so it is sealed
  // (encrypted) and bound to the Clerk session that created it. Without an
  // authenticated session there is nobody to deliver it to — fail closed
  // rather than write anything readable to the browser.
  const { sessionId, userId } = await auth();
  if (!sessionId || !userId) {
    return;
  }

  const maxAge = apiKeyFlashMaxAgeSeconds(flash);
  const sealed = await sealApiKeyFlash(flash, { sessionId, userId }, maxAge);
  if (!sealed) {
    return;
  }

  const jar = await cookies();
  jar.set(API_KEY_FLASH_COOKIE, sealed, apiKeyFlashCookieOptions(await requestProjectId(), maxAge));
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export interface SaveApiKeyAuthoringInput {
  mode: ApiKeyAuthoringMode;
  keyId?: string;
  draft: ApiKeyAuthoringDraft;
}

export type SaveApiKeyAuthoringResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

function parseOptionalExpiration(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid_expiration");
  }
  return parsed.toISOString();
}

function validateAuthoringDraft(
  draft: ApiKeyAuthoringDraft
): "name" | "wallet" | "operations" | null {
  if (!draft.name.trim()) {
    return "name";
  }
  if (draft.walletScope === "selected" && draft.selectedWalletIds.length === 0) {
    return "wallet";
  }
  if (draft.operationsScope === "selected" && draft.selectedOperations.length === 0) {
    return "operations";
  }
  return null;
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
  const t = await getTranslations();
  const { keyId, keyName, confirmation } = normalizeDeactivateApiKeyInput(input);

  if (!keyId) {
    return {
      ok: false,
      message: t("DashboardCustody.missingApiKeyIdForDeletion"),
    };
  }

  if (!keyName) {
    return {
      ok: false,
      message: t("DashboardCustody.missingApiKeyNameForDeletion"),
    };
  }

  if (!confirmation) {
    return {
      ok: false,
      message: t("DashboardCustody.confirmApiKeyDeletion"),
    };
  }

  if (confirmation !== keyName) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeyConfirmationMismatch"),
    };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch(`/v1/api-keys/${keyId}`, {
      method: "DELETE",
      body: JSON.stringify({
        confirmation,
      }),
    });

    return {
      ok: true,
      message: t("DashboardCustody.apiKeyDeactivated", { name: keyName }),
    };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeyDeleteFailed", { error: extractErrorMessage(error) }),
    };
  }
}

export async function saveApiKeyAuthoringAction(
  input: SaveApiKeyAuthoringInput
): Promise<SaveApiKeyAuthoringResult> {
  const t = await getTranslations();
  const validationError = validateAuthoringDraft(input.draft);
  if (validationError === "name") {
    return { ok: false, message: t("DashboardCustody.apiKeyNameRequired") };
  }
  if (validationError === "wallet") {
    return { ok: false, message: t("DashboardCustody.apiKeyWalletRequired") };
  }
  if (validationError === "operations") {
    return { ok: false, message: t("DashboardCustody.apiKeyOperationsRequired") };
  }

  let expiresAt: string | null;
  try {
    expiresAt = parseOptionalExpiration(input.draft.expiresAt);
  } catch {
    return { ok: false, message: t("DashboardCustody.invalidExpirationDate") };
  }

  const walletPayload = buildEndpointWalletPayload(input.draft);
  const allowedOperations = buildAllowedOperations(input.draft);

  try {
    const client = await createSdpApiClient();

    if (input.mode === "create") {
      const created = await client.fetch<{
        apiKey: { id: string; name: string; key: string; keyPrefix: string };
      }>("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: input.draft.name.trim(),
          role: input.draft.role,
          ...walletPayload,
          ...(allowedOperations.length > 0 ? { allowedOperations } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        }),
      });

      await setFlash({
        level: "success",
        message: t("DashboardCustody.apiKeyCreated", { name: created.apiKey.name }),
        key: created.apiKey.key,
        apiKeyId: created.apiKey.id,
        keyPrefix: created.apiKey.keyPrefix,
      });
      revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
      return {
        ok: true,
        message: t("DashboardCustody.apiKeyCreated", { name: created.apiKey.name }),
      };
    }

    const keyId = input.keyId?.trim();
    if (!keyId) {
      return { ok: false, message: t("DashboardCustody.apiKeyEditMissingId") };
    }

    await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: input.draft.name.trim(),
        expiresAt,
        // `walletScope: "all"` alone resets the key to every wallet. The API refuses it
        // next to any wallet field, null included.
        ...walletPayload,
        // An empty list clears the restriction.
        allowedOperations: allowedOperations.length > 0 ? allowedOperations : null,
      }),
    });

    await setFlash({
      level: "success",
      message: t("DashboardCustody.apiKeyUpdated", { name: input.draft.name.trim() }),
    });
    revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
    revalidatePath(
      await requestProjectHref(`${API_KEYS_PAGE_PATH}/${encodeURIComponent(keyId)}/edit`),
      "page"
    );
    return {
      ok: true,
      message: t("DashboardCustody.apiKeyUpdated", { name: input.draft.name.trim() }),
    };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeySaveFailed", { error: extractErrorMessage(error) }),
    };
  }
}

export async function rotateApiKeyAction(formData: FormData) {
  const t = await getTranslations();
  const locale = await getRequestLocale();
  const keyId = String(formData.get("keyId") ?? "").trim();
  const gracePeriodHours = Math.min(168, Math.max(0, parsePositiveInt(formData.get("grace"), 24)));

  if (!keyId) {
    await setFlash({
      level: "error",
      message: t("DashboardCustody.missingApiKeyIdForRotation"),
    });
    redirect(await requestProjectHref(API_KEYS_PAGE_PATH));
  }

  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<{
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
      message: t("DashboardCustody.apiKeyRotated", {
        deadline: new Date(response.previousKey.rotationDeadline).toLocaleString(locale),
      }),
      key: response.apiKey.key,
      apiKeyId: response.apiKey.id,
      keyPrefix: response.apiKey.keyPrefix,
    });
  } catch (error) {
    await setFlash({
      level: "error",
      message: t("DashboardCustody.apiKeyRotateFailed", { error: extractErrorMessage(error) }),
    });
  }

  revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
  redirect(await requestProjectHref(API_KEYS_PAGE_PATH));
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

  revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
  redirect(await requestProjectHref(API_KEYS_PAGE_PATH));
}

export async function deactivateApiKeyInlineAction(input: {
  keyId: string;
  keyName: string;
  confirmation: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const result = await deactivateApiKeyRequest(input);
  if (result.ok) {
    revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
  }

  return result;
}
