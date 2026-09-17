"use client";

import { useState } from "react";
import Link from "next/link";
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

  const detachSecret = () => {
    if (selectedPlaygroundApiKeyId) {
      clearStoredApiKeySecret({ apiKeyId: selectedPlaygroundApiKeyId });
    }
    setSelectedPlaygroundApiKeyId(null);
  };

  const onChange = (rawValue: string) => {
    const normalized = normalizeApiKeyInput(rawValue);
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

    setResolution({ kind: "checking" });
    const result = await resolveApiKey(draft);
    if ("error" in result) {
      setResolution({
        kind: "rejected",
        message: result.error || t("Shared.SharedComponents.apiKeyNotAvailable"),
      });
      return;
    }

    storeApiKeySecret({ value: draft, apiKeyId: result.id });
    setSelectedPlaygroundApiKeyId(result.id);
    setDraft(null);
    setResolution({ kind: "resolved", name: result.name, keyPrefix: result.keyPrefix });
  };

  if (playgroundApiKeys.length === 0) {
    if (!dashboardAccess.capabilities.canManageApiKeys) {
      return null;
    }

    return (
      <Button asChild className="h-11 rounded-[14px] px-4 whitespace-nowrap">
        <Link href="/dashboard/api-keys">{t("Shared.SharedComponents.createApiKey")}</Link>
      </Button>
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
