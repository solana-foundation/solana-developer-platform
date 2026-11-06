"use server";

import { auth } from "@clerk/nextjs/server";
import type { Action } from "@sdp/types/actions";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient, requestProjectHref, requestProjectId } from "@/lib/sdp-api";
import type { EndpointWalletPayload } from "./api-key-authoring";
import {
  API_KEY_FLASH_COOKIE,
  API_KEY_FLASH_MAX_AGE_SECONDS,
  API_KEYS_PAGE_PATH,
  type ApiKeyFlash,
  apiKeyFlashCookieOptions,
} from "./api-key-flash";
import { sealApiKeyFlash } from "./api-key-flash-seal";
import { API_KEY_ROTATION_GRACE_HOURS } from "./api-key-presentation";

export type ApiKeyActionResult = { ok: true } | { ok: false; message: string };
export type ApiKeyIssueResult = { ok: true; keyId: string } | { ok: false; message: string };

async function setFlash(flash: ApiKeyFlash) {
  // The flash carries a freshly generated secret, so it is sealed (encrypted)
  // and bound to the Clerk session that created it. Without an authenticated
  // session there is nobody to deliver it to: fail closed rather than write
  // anything readable to the browser.
  const { sessionId, userId } = await auth();
  if (!sessionId || !userId) {
    return;
  }
  const sealed = await sealApiKeyFlash(flash, { sessionId, userId }, API_KEY_FLASH_MAX_AGE_SECONDS);
  if (!sealed) {
    return;
  }
  const jar = await cookies();
  jar.set(
    API_KEY_FLASH_COOKIE,
    sealed,
    apiKeyFlashCookieOptions(await requestProjectId(), API_KEY_FLASH_MAX_AGE_SECONDS)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function keyPath(keyId: string): string {
  return `${API_KEYS_PAGE_PATH}/${encodeURIComponent(keyId)}`;
}

async function revalidateKeyPages(keyIds: readonly string[]) {
  revalidatePath(await requestProjectHref(API_KEYS_PAGE_PATH), "page");
  for (const keyId of keyIds) {
    revalidatePath(await requestProjectHref(keyPath(keyId)), "page");
  }
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export interface CreateApiKeyInput {
  name: string;
  grants: Action[];
  wallets: EndpointWalletPayload;
  /** Null: the key never expires. */
  expiresAt: string | null;
}

export async function createApiKeyAction(input: CreateApiKeyInput): Promise<ApiKeyIssueResult> {
  const t = await getTranslations();
  const name = input.name.trim();
  if (!name) {
    return { ok: false, message: t("DashboardCustody.apiKeyNameRequired") };
  }
  if (input.grants.length === 0) {
    return { ok: false, message: t("DashboardCustody.apiKeyGrantsRequired") };
  }
  if (input.wallets.walletScope === "selected" && input.wallets.walletIds.length === 0) {
    return { ok: false, message: t("DashboardCustody.apiKeyWalletRequired") };
  }
  if (input.expiresAt !== null && !isIsoDate(input.expiresAt)) {
    return { ok: false, message: t("DashboardCustody.invalidExpirationDate") };
  }

  try {
    const client = await createSdpApiClient();
    const created = await client.fetch<{ apiKey: { id: string; key: string } }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name,
        grants: input.grants,
        ...input.wallets,
        // JSON drops an undefined field: no expiry is sent as none.
        expiresAt: input.expiresAt ?? undefined,
      }),
    });
    await setFlash({ keyId: created.apiKey.id, key: created.apiKey.key });
    await revalidateKeyPages([]);
    return { ok: true, keyId: created.apiKey.id };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeySaveFailed", { error: errorMessage(error) }),
    };
  }
}

/** One section's edit: only the fields it names are sent, so the key keeps the rest. */
export interface UpdateApiKeyInput {
  name?: string;
  description?: string | null;
  expiresAt?: string | null;
  allowedIps?: string[] | null;
  grants?: Action[];
  wallets?: EndpointWalletPayload;
}

export async function updateApiKeyAction(
  keyId: string,
  input: UpdateApiKeyInput
): Promise<ApiKeyActionResult> {
  const t = await getTranslations();
  if (input.name !== undefined && !input.name.trim()) {
    return { ok: false, message: t("DashboardCustody.apiKeyNameRequired") };
  }
  if (input.grants !== undefined && input.grants.length === 0) {
    return { ok: false, message: t("DashboardCustody.apiKeyGrantsRequired") };
  }
  if (input.wallets?.walletScope === "selected" && input.wallets.walletIds.length === 0) {
    return { ok: false, message: t("DashboardCustody.apiKeyWalletRequired") };
  }
  if (input.expiresAt && !isIsoDate(input.expiresAt)) {
    return { ok: false, message: t("DashboardCustody.invalidExpirationDate") };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}`, {
      method: "PATCH",
      // `walletScope: "all"` alone resets the key to every wallet: the API refuses it next to
      // any wallet field, null included. Fields left undefined drop out of the JSON.
      body: JSON.stringify({
        name: input.name?.trim(),
        description: input.description,
        expiresAt: input.expiresAt,
        allowedIps: input.allowedIps,
        grants: input.grants,
        ...input.wallets,
      }),
    });
    await revalidateKeyPages([keyId]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeySaveFailed", { error: errorMessage(error) }),
    };
  }
}

export async function rotateApiKeyAction(
  keyId: string,
  gracePeriodHours: number
): Promise<ApiKeyIssueResult> {
  const t = await getTranslations();
  if (!API_KEY_ROTATION_GRACE_HOURS.some((hours) => hours === gracePeriodHours)) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeyRotateFailed", { error: "grace period" }),
    };
  }
  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<{ apiKey: { id: string; key: string } }>(
      `/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
      { method: "POST", body: JSON.stringify({ gracePeriodHours }) }
    );
    await setFlash({ keyId: response.apiKey.id, key: response.apiKey.key });
    await revalidateKeyPages([keyId]);
    return { ok: true, keyId: response.apiKey.id };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeyRotateFailed", { error: errorMessage(error) }),
    };
  }
}

export async function revokeApiKeyAction(input: {
  keyId: string;
  keyName: string;
  cancelRecurringPayments: boolean;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    // The hold on the revoke button is the confirmation; the API still checks the name.
    const response = await client.fetch<{
      recurringPayments: { canceled: string[]; failed: string[] } | null;
    }>(`/v1/api-keys/${encodeURIComponent(input.keyId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        confirmation: input.keyName,
        cancelRecurringPayments: input.cancelRecurringPayments,
      }),
    });
    await revalidateKeyPages([input.keyId]);
    const revoked = t("DashboardCustody.apiKeyDeactivated", { name: input.keyName });
    const recurring = response.recurringPayments;
    if (!input.cancelRecurringPayments || !recurring) {
      return { ok: true, message: revoked };
    }
    // The key is revoked either way; a payment that could not be canceled is
    // reported so it can be canceled on its own.
    return {
      ok: true,
      message: `${revoked} ${t("DashboardCustody.apiKeyRecurringCanceled", {
        canceled: recurring.canceled.length,
        failed: recurring.failed.length,
      })}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: t("DashboardCustody.apiKeyDeleteFailed", { error: errorMessage(error) }),
    };
  }
}
