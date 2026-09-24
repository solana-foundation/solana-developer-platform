"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  clearStoredApiKeySecret,
  isValidSdpApiKey,
  normalizeApiKeyInput,
  storeApiKeySecret,
} from "@/lib/playground-api-keys";
import { usePlaygroundApiKeySecret } from "@/lib/use-playground-api-key-secret";

type Resolution =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "resolved"; name: string; keyPrefix: string }
  | { kind: "rejected"; message: string };

interface ResolvedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
}

async function resolveApiKey(apiKey: string): Promise<ResolvedApiKey | { error: string }> {
  // Every failure has to come back as a value. A throw here escapes the caller
  // after it has set the checking state, which leaves the field checking forever.
  // The empty body of an older API that answers 204 lands here too, as a json()
  // rejection rather than a response we can read.
  try {
    const response = await fetch("/api/playground/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    const payload = (await response.json()) as Partial<ResolvedApiKey> & { error?: string };
    if (!response.ok) {
      return { error: payload.error ?? "" };
    }
    if (!payload.id || !payload.name || !payload.keyPrefix) {
      return { error: "" };
    }
    return { id: payload.id, name: payload.name, keyPrefix: payload.keyPrefix };
  } catch {
    return { error: "" };
  }
}

const ROLE_LABEL_KEYS = {
  api_admin: "DashboardCustody.admin",
  api_readonly: "DashboardCustody.readOnly",
  api_developer: "DashboardCustody.developer",
} as const;

const ENVIRONMENT_LABEL_KEYS = {
  production: "DashboardCustody.production",
  sandbox: "DashboardCustody.sandbox",
} as const;

function labelKeyFor<T extends Record<string, string>>(keys: T, value: string): T[keyof T] | null {
  return Object.hasOwn(keys, value) ? keys[value as keyof T] : null;
}

/**
 * One control, not two. You paste key material and the server tells us which key
 * it is, by hashing the whole key inside the project boundary.
 *
 * This replaced a picker listing every key in the project. The picker had to go
 * for two reasons. It rendered as a second text field, which is what made the
 * playground look like it wanted the same thing twice. And listing the keys put
 * any key in the project one click away, where pasting requires already holding
 * the key you want to use.
 *
 * The key id still keys secret storage, workspace scoping and the inactivity
 * expiry. It now comes from the matched row rather than from a selection, so it
 * is never inferred from the visible prefix, which is three characters of
 * entropy and collides.
 */
export function PlaygroundApiKeySelector() {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const {
    dashboardAccess,
    playgroundApiKeys,
    selectedPlaygroundApiKeyId,
    setSelectedPlaygroundApiKeyId,
  } = useDashboardWorkspace();
  const storedSecret = usePlaygroundApiKeySecret({ apiKeyId: selectedPlaygroundApiKeyId });

  /**
   * Held only while the pasted key is unidentified. Once the server names the
   * key the value moves into the store, which owns expiry and scope clearing,
   * and the field reads from there. A null draft means "show what is stored".
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>({ kind: "idle" });

  /**
   * Identifies the in-flight request. Editing the field or starting a new
   * identification invalidates whatever is already in flight, so a slow answer
   * for material the user has since replaced cannot attach that older key or
   * overwrite what they typed next.
   */
  const identifyRequestRef = useRef(0);

  const detachSecret = () => {
    if (selectedPlaygroundApiKeyId) {
      clearStoredApiKeySecret({ apiKeyId: selectedPlaygroundApiKeyId });
    }
    setSelectedPlaygroundApiKeyId(null);
  };

  const onChange = (rawValue: string) => {
    const normalized = normalizeApiKeyInput(rawValue);
    identifyRequestRef.current += 1;
    setDraft(normalized);
    setResolution({ kind: "idle" });
    // A key already attached stops being the active key the moment the field is
    // edited, so a stale secret cannot outlive the value on screen.
    detachSecret();
  };

  const onIdentify = async () => {
    if (draft === null) {
      return;
    }
    if (!draft) {
      setResolution({ kind: "idle" });
      return;
    }
    if (!isValidSdpApiKey(draft)) {
      setResolution({
        kind: "rejected",
        message: t("Shared.SharedComponents.invalidApiKeyFormat"),
      });
      return;
    }

    const material = draft;
    const requestId = identifyRequestRef.current + 1;
    identifyRequestRef.current = requestId;

    setResolution({ kind: "checking" });
    const result = await resolveApiKey(material);
    if (requestId !== identifyRequestRef.current) {
      return;
    }

    if ("error" in result) {
      setResolution({
        kind: "rejected",
        message: result.error || t("Shared.SharedComponents.apiKeyNotAvailable"),
      });
      return;
    }

    storeApiKeySecret({ value: material, apiKeyId: result.id });
    setSelectedPlaygroundApiKeyId(result.id);
    setDraft(null);
    setResolution({ kind: "resolved", name: result.name, keyPrefix: result.keyPrefix });
  };

  if (playgroundApiKeys.length === 0) {
    if (!dashboardAccess.capabilities.canManageApiKeys) {
      return null;
    }

    return refresh ? (
      <Link href="/dashboard/api-keys" className="text-primary underline-offset-4 hover:underline">
        {t("Shared.SharedComponents.createApiKey")}
      </Link>
    ) : (
      <Button asChild className="h-11 rounded-[14px] px-4 whitespace-nowrap">
        <Link href="/dashboard/api-keys">{t("Shared.SharedComponents.createApiKey")}</Link>
      </Button>
    );
  }

  if (refresh) {
    // Inline on the playground's key line: the field, then what the attached key is allowed to
    // do and where, from the project's own key list.
    // Only a key whose secret is still held here is in use; an expired one names nothing.
    const attached = storedSecret
      ? playgroundApiKeys.find((key) => key.id === selectedPlaygroundApiKeyId)
      : undefined;
    const roleKey = attached ? labelKeyFor(ROLE_LABEL_KEYS, attached.role) : null;
    const environmentKey = attached
      ? labelKeyFor(ENVIRONMENT_LABEL_KEYS, attached.environment)
      : null;
    const details = [
      attached?.name,
      roleKey ? t(roleKey) : null,
      environmentKey ? t(environmentKey) : null,
    ].filter((entry): entry is string => Boolean(entry));
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Input
          aria-label={t("Shared.SharedComponents.apiKeyValue")}
          autoComplete="new-password"
          className="w-64 max-w-full"
          size="md"
          onBlur={onIdentify}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={t("Shared.SharedComponents.apiKeySecretPlaceholder")}
          spellCheck={false}
          type="password"
          value={draft ?? storedSecret ?? ""}
        />
        {resolution.kind === "checking" ? (
          <span className="text-tertiary">{t("Shared.SharedComponents.apiKeyChecking")}</span>
        ) : null}
        {resolution.kind === "rejected" ? (
          <span className="text-error" role="alert">
            {resolution.message}
          </span>
        ) : null}
        {resolution.kind !== "checking" && resolution.kind !== "rejected"
          ? details.map((detail) => (
              <span
                key={detail}
                className="flex items-center gap-3 text-primary"
                data-testid={detail === attached?.name ? "playground-api-key-identity" : undefined}
              >
                <span aria-hidden="true" className="text-secondary">
                  ·
                </span>
                {detail}
              </span>
            ))
          : null}
      </span>
    );
  }

  return (
    <div className="grid w-full min-w-[260px] gap-1.5 lg:max-w-[360px]">
      <Input
        aria-label={t("Shared.SharedComponents.apiKeyValue")}
        autoComplete="new-password"
        className="h-11 rounded-[14px]"
        onBlur={onIdentify}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t("Shared.SharedComponents.apiKeySecretPlaceholder")}
        spellCheck={false}
        type="password"
        value={draft ?? storedSecret ?? ""}
      />
      {resolution.kind === "checking" ? (
        <p className="text-tertiary text-xs">{t("Shared.SharedComponents.apiKeyChecking")}</p>
      ) : null}
      {resolution.kind === "resolved" ? (
        <p className="text-tertiary text-xs" data-testid="playground-api-key-identity">
          {`${t("Shared.SharedComponents.apiKeyInUse")}: ${resolution.name}`}
        </p>
      ) : null}
      {resolution.kind === "rejected" ? (
        <p className="text-xs text-red-400" role="alert">
          {resolution.message}
        </p>
      ) : null}
    </div>
  );
}
