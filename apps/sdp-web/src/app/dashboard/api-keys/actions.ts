"use server";

import type {
  ApiKeyControlProfile,
  ApiKeyControlProfileRevision,
  ApiKeyRole,
  ApiKeyWalletPolicyBindingSummary,
  ApiKeyWalletScope,
} from "@sdp/types";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import {
  type ApiKeyAuthoringDraft,
  type ApiKeyAuthoringMode,
  type BindingConfirmation,
  buildApiKeyPolicyRules,
  buildEndpointWalletPayload,
  buildPolicyBindingTargets,
  getPolicyBindingIntent,
  isPositiveDecimal,
  type PolicyBindingIntent,
  requiredBindingConfirmation,
} from "./api-key-authoring";
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

interface ApiKeyDetail {
  id: string;
  name: string;
  role: ApiKeyRole;
  expiresAt: string | null;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
}

export interface SaveApiKeyAuthoringInput {
  mode: ApiKeyAuthoringMode;
  keyId?: string;
  draft: ApiKeyAuthoringDraft;
  bindingConfirmation?: BindingConfirmation;
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

function validateAuthoringDraft(draft: ApiKeyAuthoringDraft): "name" | "wallet" | "amount" | null {
  if (!draft.name.trim()) {
    return "name";
  }
  if (draft.walletScope === "selected" && draft.selectedWalletIds.length === 0) {
    return "wallet";
  }
  if (draft.restrictionsEnabled && draft.maximumAmount && !isPositiveDecimal(draft.maximumAmount)) {
    return "amount";
  }
  return null;
}

async function createAndActivateRestrictionProfile(
  client: SdpApiClient,
  keyId: string,
  draft: ApiKeyAuthoringDraft
): Promise<string> {
  const { profile } = await client.fetch<{ profile: ApiKeyControlProfile }>(
    `/v1/api-keys/${encodeURIComponent(keyId)}/policy-profiles`,
    {
      method: "POST",
      body: JSON.stringify({ name: `${draft.name.trim()} additional restrictions` }),
    }
  );
  await createAndActivateRestrictionRevision(client, keyId, profile.id, draft);
  return profile.id;
}

async function createAndActivateRestrictionRevision(
  client: SdpApiClient,
  keyId: string,
  profileId: string,
  draft: ApiKeyAuthoringDraft
): Promise<void> {
  const { revision } = await client.fetch<{ revision: ApiKeyControlProfileRevision }>(
    `/v1/api-keys/${encodeURIComponent(keyId)}/policy-profiles/${encodeURIComponent(profileId)}/revisions`,
    {
      method: "POST",
      body: JSON.stringify({
        rules: buildApiKeyPolicyRules(draft),
        defaultAction: draft.defaultAction,
      }),
    }
  );
  await client.fetch(
    `/v1/api-keys/${encodeURIComponent(keyId)}/policy-profiles/${encodeURIComponent(profileId)}/revisions/${encodeURIComponent(revision.id)}/activate`,
    { method: "POST" }
  );
}

async function activateRestrictionRevision(
  client: SdpApiClient,
  keyId: string,
  profileId: string,
  revisionId: string
): Promise<void> {
  await client.fetch(
    `/v1/api-keys/${encodeURIComponent(keyId)}/policy-profiles/${encodeURIComponent(profileId)}/revisions/${encodeURIComponent(revisionId)}/activate`,
    { method: "POST" }
  );
}

async function replacePolicyBindings(
  client: SdpApiClient,
  keyId: string,
  draft: ApiKeyAuthoringDraft,
  profileId: string
) {
  await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}/policy-bindings`, {
    method: "PUT",
    body: JSON.stringify({
      mode: "replace",
      bindings: buildPolicyBindingTargets(draft, profileId),
    }),
  });
}

async function clearPolicyBindings(client: SdpApiClient, keyId: string) {
  await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}/policy-bindings`, {
    method: "PUT",
    body: JSON.stringify({ mode: "clear" }),
  });
}

async function restoreApiKeyEndpoint(
  client: SdpApiClient,
  keyId: string,
  apiKey: ApiKeyDetail
): Promise<void> {
  await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: apiKey.name,
      expiresAt: apiKey.expiresAt,
      walletScope: apiKey.walletScope,
      ...(apiKey.walletScope === "all"
        ? { signingWalletId: null, signingWalletIds: null, walletBindings: null }
        : {
            signingWalletId: apiKey.signingWalletId,
            signingWalletIds: apiKey.signingWalletIds,
          }),
    }),
  });
}

async function applyApiKeyEdit(input: {
  client: SdpApiClient;
  keyId: string;
  apiKey: ApiKeyDetail;
  bindingIntent: PolicyBindingIntent;
  draft: ApiKeyAuthoringDraft;
  expiresAt: string | null;
  walletPayload: ReturnType<typeof buildEndpointWalletPayload>;
}): Promise<void> {
  const { client, keyId, apiKey, bindingIntent, draft, expiresAt, walletPayload } = input;
  const previousProfileRevisionId =
    bindingIntent.mode === "replace" && bindingIntent.profile === "existing"
      ? apiKey.policyBindings.find(
          (binding) => binding.apiKeyControlProfileId === bindingIntent.existingProfileId
        )?.apiKeyControlProfileRevisionId
      : null;
  let endpointUpdated = false;
  let existingProfileUpdated = false;

  try {
    await client.fetch(`/v1/api-keys/${encodeURIComponent(keyId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: draft.name.trim(),
        expiresAt,
        ...walletPayload,
        ...(draft.walletScope === "all"
          ? { signingWalletId: null, signingWalletIds: null, walletBindings: null }
          : {}),
      }),
    });
    endpointUpdated = true;

    if (bindingIntent.mode === "replace") {
      let profileId = bindingIntent.existingProfileId;
      if (bindingIntent.profile === "new") {
        profileId = await createAndActivateRestrictionProfile(client, keyId, draft);
      } else if (profileId && draft.restrictionsEdited) {
        await createAndActivateRestrictionRevision(client, keyId, profileId, draft);
        existingProfileUpdated = true;
      }
      if (profileId) {
        await replacePolicyBindings(client, keyId, draft, profileId);
      }
    } else if (bindingIntent.mode === "clear") {
      await clearPolicyBindings(client, keyId);
    }
  } catch (error) {
    if (
      existingProfileUpdated &&
      bindingIntent.mode === "replace" &&
      bindingIntent.existingProfileId &&
      previousProfileRevisionId
    ) {
      await activateRestrictionRevision(
        client,
        keyId,
        bindingIntent.existingProfileId,
        previousProfileRevisionId
      ).catch(() => undefined);
    }
    if (endpointUpdated) {
      await restoreApiKeyEndpoint(client, keyId, apiKey).catch(() => undefined);
    }
    throw error;
  }
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
  if (validationError === "amount") {
    return { ok: false, message: t("DashboardCustody.apiKeyRestrictionAmountInvalid") };
  }

  let expiresAt: string | null;
  try {
    expiresAt = parseOptionalExpiration(input.draft.expiresAt);
  } catch {
    return { ok: false, message: t("DashboardCustody.invalidExpirationDate") };
  }

  const walletPayload = buildEndpointWalletPayload(input.draft);

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
          ...(expiresAt ? { expiresAt } : {}),
        }),
      });

      try {
        if (input.draft.restrictionsEnabled) {
          const profileId = await createAndActivateRestrictionProfile(
            client,
            created.apiKey.id,
            input.draft
          );
          await replacePolicyBindings(client, created.apiKey.id, input.draft, profileId);
        }
      } catch (error) {
        await client
          .fetch(`/v1/api-keys/${encodeURIComponent(created.apiKey.id)}`, {
            method: "DELETE",
            body: JSON.stringify({ confirmation: created.apiKey.name }),
          })
          .catch(() => undefined);
        throw error;
      }

      await setFlash({
        level: "success",
        message: t("DashboardCustody.apiKeyCreated", { name: created.apiKey.name }),
        key: created.apiKey.key,
        apiKeyId: created.apiKey.id,
        keyPrefix: created.apiKey.keyPrefix,
      });
      revalidatePath(API_KEYS_PAGE_PATH, "page");
      return {
        ok: true,
        message: t("DashboardCustody.apiKeyCreated", { name: created.apiKey.name }),
      };
    }

    const keyId = input.keyId?.trim();
    if (!keyId) {
      return { ok: false, message: t("DashboardCustody.apiKeyEditMissingId") };
    }

    const apiKey = await client.fetch<ApiKeyDetail>(`/v1/api-keys/${encodeURIComponent(keyId)}`);
    const bindingIntent = getPolicyBindingIntent(
      "edit",
      {
        walletScope: apiKey.walletScope,
        selectedWalletIds: apiKey.signingWalletIds,
        policyBindings: apiKey.policyBindings,
      },
      input.draft
    );

    if (bindingIntent.mode === "blocked") {
      return {
        ok: false,
        message: t("DashboardCustody.apiKeyRestrictionReplacementRequired"),
      };
    }

    const confirmation = requiredBindingConfirmation(bindingIntent);
    if (confirmation && input.bindingConfirmation !== confirmation) {
      return {
        ok: false,
        message:
          confirmation === "clear"
            ? t("DashboardCustody.apiKeyClearBindingsConfirmationRequired")
            : t("DashboardCustody.apiKeyReplaceBindingsConfirmationRequired"),
      };
    }

    await applyApiKeyEdit({
      client,
      keyId,
      apiKey,
      bindingIntent,
      draft: input.draft,
      expiresAt,
      walletPayload,
    });

    await setFlash({
      level: "success",
      message: t("DashboardCustody.apiKeyUpdated", { name: input.draft.name.trim() }),
    });
    revalidatePath(API_KEYS_PAGE_PATH, "page");
    revalidatePath(`${API_KEYS_PAGE_PATH}/${encodeURIComponent(keyId)}/edit`, "page");
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
    redirect(API_KEYS_PAGE_PATH);
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
