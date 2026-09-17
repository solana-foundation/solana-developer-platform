"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { clearStoredApiKeySecret, storeApiKeySecret } from "@/lib/playground-api-keys";
import { usePlaygroundApiKeySecret } from "@/lib/use-playground-api-key-secret";

function formatKeyIdentifier(keyPrefix: string): string {
  const trimmed = keyPrefix.trim();
  if (!trimmed) {
    return "api_key...";
  }

  if (trimmed.endsWith("...")) {
    return trimmed;
  }

  if (trimmed.length <= 12) {
    return `${trimmed}...`;
  }

  return `${trimmed.slice(0, 12)}...`;
}

function formatApiKeyLabel(name: string, keyPrefix: string): string {
  return `${name} (${formatKeyIdentifier(keyPrefix)})`;
}

/**
 * Two controls doing two jobs: the Select says WHICH key, the field supplies its
 * secret. They are not duplicates. The key id is the only unambiguous identity
 * available here (prefixes are three characters of entropy and collide, which
 * this component's own tests pin), and storage, workspace scoping and expiry all
 * hang off it.
 *
 * The chooser used to be a hand-rolled box with an invisible native select laid
 * over it, which rendered as a bordered pill identical to the field below and
 * read as a second text input. It now uses the design-system Select, as the
 * approvals inbox and custody policy flow already do.
 */
export function PlaygroundApiKeySelector() {
  const t = useTranslations();
  const {
    dashboardAccess,
    playgroundApiKeys,
    selectedPlaygroundApiKeyId,
    setSelectedPlaygroundApiKeyId,
  } = useDashboardWorkspace();
  const selectedApiKey =
    playgroundApiKeys.find((apiKey) => apiKey.id === selectedPlaygroundApiKeyId) ??
    playgroundApiKeys[0];
  const selectedSecret = usePlaygroundApiKeySecret({
    apiKeyId: selectedApiKey?.id,
  });

  const updateSelectedSecret = (value: string) => {
    if (!selectedApiKey) {
      return;
    }

    if (!value.trim()) {
      clearStoredApiKeySecret({
        apiKeyId: selectedApiKey.id,
      });
      return;
    }

    storeApiKeySecret({
      value,
      apiKeyId: selectedApiKey.id,
    });
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
    <div className="grid w-full min-w-[260px] gap-2 lg:max-w-[360px]">
      <Select
        ariaLabel={t("Shared.SharedComponents.selectApiKey")}
        size="xl"
        iconLeft={<KeyRound className="h-4 w-4 text-tertiary" />}
        value={selectedPlaygroundApiKeyId ?? playgroundApiKeys[0].id}
        onValueChange={setSelectedPlaygroundApiKeyId}
      >
        {playgroundApiKeys.map((apiKey) => (
          <SelectItem key={apiKey.id} value={apiKey.id}>
            {formatApiKeyLabel(apiKey.name, apiKey.keyPrefix)}
          </SelectItem>
        ))}
      </Select>
      <Input
        aria-label={t("Shared.SharedComponents.apiKeyValue")}
        autoComplete="new-password"
        className="h-11 rounded-[14px]"
        onChange={(event) => updateSelectedSecret(event.currentTarget.value)}
        placeholder={t("Shared.SharedComponents.apiKeySecretPlaceholder")}
        spellCheck={false}
        type="password"
        value={selectedSecret ?? ""}
      />
    </div>
  );
}
