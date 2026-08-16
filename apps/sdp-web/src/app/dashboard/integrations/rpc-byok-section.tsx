"use client";

import { rpcProviderNeedsEndpoint, type SafeRpcConnection } from "@sdp/types";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import {
  activateRpcConnectionAction,
  deactivateRpcConnectionAction,
  submitRpcConnectionAction,
} from "./rpc-connection-actions";

/**
 * Tenant-owned credentials for one provider (HOO-1090).
 *
 * The key field is write-only by construction: it is cleared on submit and the
 * API's response type carries no field that could return it, so nothing here
 * can repopulate a stored secret.
 */
export function RpcByokSection({
  canManage,
  connections,
  provider,
}: {
  canManage: boolean;
  connections: SafeRpcConnection[];
  provider: string;
}) {
  const t = useTranslations();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [network, setNetwork] = useState("devnet");
  const [showKey, setShowKey] = useState(false);
  const needsEndpoint = rpcProviderNeedsEndpoint(provider);

  const runConnectionAction = async (
    action: typeof activateRpcConnectionAction,
    connectionId: string
  ) => {
    setPendingId(connectionId);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    formData.set("provider", provider);
    try {
      const result = await action(formData);
      if (result.status === "success") {
        toast.success(t("Shared.integrations.rpcByokUpdated"), { position: "bottom-right" });
      } else {
        toast.error(result.message, { position: "bottom-right" });
      }
    } finally {
      setPendingId(null);
    }
  };

  const submit = async () => {
    setIsSubmitting(true);
    const formData = new FormData();
    formData.set("provider", provider);
    formData.set("network", network);
    formData.set("scope", "organization");
    formData.set("credentialLabel", credentialLabel);
    formData.set("endpointUrl", endpointUrl);
    formData.set("apiKey", apiKey);

    try {
      const result = await submitRpcConnectionAction(formData);
      if (result.status === "success") {
        // Clear the secret first: a failed re-render must not leave it sitting
        // in a mounted input.
        setApiKey("");
        setCredentialLabel("");
        setEndpointUrl("");
        setIsFormOpen(false);
        setShowKey(false);
        toast.success(t("Shared.integrations.rpcByokAdded"), { position: "bottom-right" });
        return;
      }
      toast.error(result.message, { position: "bottom-right" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-5" data-rpc-byok={provider}>
      <p className="max-w-3xl text-sm leading-6 text-pretty text-secondary">
        {t("Shared.integrations.rpcByokDescription")}
      </p>

      {connections.length > 0 ? (
        <ul className="space-y-2">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-primary">
                    {connection.providerCredential.label}
                  </span>
                  {connection.isDefault && connection.status === "active" ? (
                    <Badge variant="success">{t("Shared.integrations.rpcByokServing")}</Badge>
                  ) : (
                    <Badge variant="outline">{connection.status}</Badge>
                  )}
                </div>
                <p className="text-xs text-tertiary">
                  {connection.network}
                  {typeof connection.displayMetadata.endpointHost === "string"
                    ? ` · ${connection.displayMetadata.endpointHost}`
                    : ""}
                  {typeof connection.displayMetadata.apiKeySuffix === "string"
                    ? ` · ····${connection.displayMetadata.apiKeySuffix}`
                    : ""}
                </p>
                {connection.lastCheck?.failureCode ? (
                  <p className="text-xs text-error">{connection.lastCheck.failureCode}</p>
                ) : null}
              </div>

              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {connection.status !== "active" ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={pendingId === connection.id}
                      onClick={() => {
                        void runConnectionAction(activateRpcConnectionAction, connection.id);
                      }}
                    >
                      {t("Shared.integrations.rpcByokUse")}
                    </Button>
                  ) : null}
                  {connection.status !== "deactivated" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pendingId === connection.id}
                      onClick={() => {
                        void runConnectionAction(deactivateRpcConnectionAction, connection.id);
                      }}
                    >
                      {t("Shared.integrations.rpcByokDeactivate")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-6 text-tertiary">{t("Shared.integrations.rpcByokEmpty")}</p>
      )}

      {canManage ? (
        <div className="space-y-3">
          {/* Collapsed by default: most visits are to read what is connected,
              not to add a credential, and a permanently open secret field is
              noise on a page that is mostly status. */}
          <Button
            type="button"
            variant={isFormOpen ? "secondary" : "default"}
            aria-expanded={isFormOpen}
            aria-controls="rpc-byok-form"
            onClick={() => setIsFormOpen((open) => !open)}
          >
            {isFormOpen
              ? t("Shared.integrations.rpcByokCancel")
              : t("Shared.integrations.rpcByokAdd")}
          </Button>

          <form
            id="rpc-byok-form"
            hidden={!isFormOpen}
            className="grid gap-4 rounded-xl border border-border-default p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-primary">
                  {t("Shared.integrations.rpcByokLabel")}
                </span>
                <Input
                  required
                  value={credentialLabel}
                  onChange={(event) => setCredentialLabel(event.target.value)}
                  placeholder={t("Shared.integrations.rpcByokLabelPlaceholder")}
                />
              </label>
              <div className="grid gap-1.5 text-sm">
                <span className="font-medium text-primary">
                  {t("Shared.integrations.rpcByokNetwork")}
                </span>
                <Select
                  ariaLabel={t("Shared.integrations.rpcByokNetwork")}
                  value={network}
                  onValueChange={(value) => {
                    if (value) setNetwork(value);
                  }}
                >
                  <SelectItem value="devnet">devnet</SelectItem>
                  <SelectItem value="mainnet-beta">mainnet-beta</SelectItem>
                </Select>
              </div>
            </div>

            {/* Only providers that issue an account-specific host make the
                tenant type one; for the rest the published endpoint is used. */}
            {needsEndpoint ? (
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-primary">
                  {t("Shared.integrations.rpcByokEndpoint")}
                </span>
                <Input
                  required
                  type="url"
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                  placeholder="https://your-endpoint.example"
                />
                <span className="text-xs text-tertiary">
                  {t("Shared.integrations.rpcByokEndpointHint")}{" "}
                  {/* Rendered as an element, not copy: translate() reads braces
                    in a message as an interpolation slot and throws on render. */}
                  <code className="rounded bg-fill-subtle px-1 font-mono">{"{API_KEY}"}</code>
                </span>
              </label>
            ) : null}

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-primary">
                {t("Shared.integrations.rpcByokApiKey")}
              </span>
              <div className="flex items-center gap-2">
                <Input
                  required
                  className="flex-1"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                {/* A typo in a masked field is the usual reason a first
                    activation fails, so the value is checkable before saving. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-pressed={showKey}
                  onClick={() => setShowKey((shown) => !shown)}
                >
                  {showKey
                    ? t("Shared.integrations.rpcByokHideKey")
                    : t("Shared.integrations.rpcByokShowKey")}
                </Button>
              </div>
              <span className="text-xs text-tertiary">
                {t("Shared.integrations.rpcByokApiKeyHint")}
              </span>
            </label>

            <div>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t("Shared.integrations.rpcByokAdding")
                  : t("Shared.integrations.rpcByokSave")}
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <p className="text-sm leading-6 text-tertiary">
          {t("Shared.integrations.rpcByokAdminOnly")}
        </p>
      )}
    </div>
  );
}
