"use client";

import { SOLANA_CLUSTER_LABELS } from "@sdp/types";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { useId, useRef, useState } from "react";
import { useThemeScope, useThemeScopeAttributes } from "@/components/theme-scope";
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
import { useSolanaCluster } from "@/lib/use-solana-cluster";

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

// The key line names the environment in lower case, as part of the key's label ("Server · production").
const KEY_ENVIRONMENT_LABEL_KEYS = {
  production: "Shared.SharedComponents.apiKeyProduction",
  sandbox: "Shared.SharedComponents.apiKeySandbox",
} as const;

function labelKeyFor<T extends Record<string, string>>(keys: T, value: string): T[keyof T] | null {
  return Object.hasOwn(keys, value) ? keys[value as keyof T] : null;
}

/**
 * The pasted key and what the server says it is. You paste key material and the server tells us
 * which key it is, by hashing the whole key inside the project boundary.
 *
 * The key id still keys secret storage, workspace scoping and the inactivity expiry. It comes
 * from the matched row rather than from a selection, so it is never inferred from the visible
 * prefix, which is three characters of entropy and collides.
 */
function usePastedApiKey() {
  const t = useTranslations();
  const { playgroundApiKeys, selectedPlaygroundApiKeyId, setSelectedPlaygroundApiKeyId } =
    useDashboardWorkspace();
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

  return {
    value: draft ?? storedSecret ?? "",
    resolution,
    onChange,
    onIdentify,
    // Only a key whose secret is still held here is in use; an expired one names nothing.
    attached: storedSecret
      ? playgroundApiKeys.find((key) => key.id === selectedPlaygroundApiKeyId)
      : undefined,
  };
}

type PastedApiKey = ReturnType<typeof usePastedApiKey>;

function Separator() {
  return (
    <span aria-hidden="true" className="text-tertiary">
      ·
    </span>
  );
}

/**
 * The playground's key line on a refresh surface: the attached key's name and environment as a
 * trigger with the paste field behind it, then what the key may do and the cluster it runs on.
 * The popover takes key material you already hold; it never lists the project's keys.
 */
function RefreshApiKeyPicker({ pasted }: { pasted: PastedApiKey }) {
  const t = useTranslations();
  const themeScopeAttributes = useThemeScopeAttributes();
  const cluster = useSolanaCluster();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const { attached, resolution } = pasted;
  const roleKey = attached ? labelKeyFor(ROLE_LABEL_KEYS, attached.role) : null;
  const environmentKey = attached
    ? labelKeyFor(KEY_ENVIRONMENT_LABEL_KEYS, attached.environment)
    : null;
  const triggerLabel = attached
    ? [attached.name, environmentKey ? t(environmentKey) : null].filter(Boolean).join(" · ")
    : t("Shared.SharedComponents.pasteApiKey");
  // Closing the popover (outside click, Tab away, Escape, Enter) is what identifies the paste.
  const close = () => {
    setOpen(false);
    void pasted.onIdentify();
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm text-body leading-4 tracking-[-0.01em] text-primary outline-none transition-colors hover:text-secondary focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            <span data-testid={attached ? "playground-api-key-identity" : undefined}>
              {triggerLabel}
            </span>
            <ChevronDown aria-hidden="true" className="size-4 text-tertiary" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            {...themeScopeAttributes}
            align="start"
            sideOffset={8}
            className="z-50 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] p-4"
          >
            <label htmlFor={fieldId} className="block text-meta text-secondary">
              {t("Shared.SharedComponents.apiKeyValue")}
            </label>
            <Input
              id={fieldId}
              autoComplete="new-password"
              size="md"
              onChange={(event) => pasted.onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault();
                  close();
                }
              }}
              placeholder={t("Shared.SharedComponents.apiKeySecretPlaceholder")}
              spellCheck={false}
              type="password"
              value={pasted.value}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {resolution.kind === "checking" ? (
        <span className="text-tertiary">{t("Shared.SharedComponents.apiKeyChecking")}</span>
      ) : null}
      {resolution.kind === "rejected" ? (
        <span className="text-error" role="alert">
          {resolution.message}
        </span>
      ) : null}
      {resolution.kind !== "checking" && resolution.kind !== "rejected" ? (
        <>
          {roleKey ? (
            <>
              <Separator />
              <span className="text-secondary">{t(roleKey)}</span>
            </>
          ) : null}
          <Separator />
          <span className="text-primary">{SOLANA_CLUSTER_LABELS[cluster]}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * One control, not two. You paste key material and the server tells us which key
 * it is.
 *
 * This replaced a picker listing every key in the project. The picker had to go
 * for two reasons. It rendered as a second text field, which is what made the
 * playground look like it wanted the same thing twice. And listing the keys put
 * any key in the project one click away, where pasting requires already holding
 * the key you want to use.
 */
export function PlaygroundApiKeySelector() {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const { dashboardAccess, playgroundApiKeys } = useDashboardWorkspace();
  const pasted = usePastedApiKey();

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
    return <RefreshApiKeyPicker pasted={pasted} />;
  }

  const { resolution } = pasted;
  return (
    <div className="grid w-full min-w-[260px] gap-1.5 lg:max-w-[360px]">
      <Input
        aria-label={t("Shared.SharedComponents.apiKeyValue")}
        autoComplete="new-password"
        className="h-11 rounded-[14px]"
        onBlur={pasted.onIdentify}
        onChange={(event) => pasted.onChange(event.currentTarget.value)}
        placeholder={t("Shared.SharedComponents.apiKeySecretPlaceholder")}
        spellCheck={false}
        type="password"
        value={pasted.value}
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
