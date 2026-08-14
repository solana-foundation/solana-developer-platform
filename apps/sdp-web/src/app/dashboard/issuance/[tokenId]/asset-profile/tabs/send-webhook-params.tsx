"use client";

import Link from "next/link";
import { useState } from "react";
import type { WebhookEndpointsPage } from "@/app/dashboard/webhooks/webhook-endpoints.data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";

type Wf = (key: string, values?: Record<string, string | number>) => string;
type Mode = "registry" | "custom";

// send_webhook's param block: a registered endpoint from /dashboard/webhooks (the
// default) or the legacy inline URL + optional secret. The two shapes are mutually
// exclusive server-side, so switching modes clears the other mode's params. Key this
// component by the editing rule id — mode is derived from params only on mount.
export function SendWebhookParams({
  // Bound as `t` so the ui-copy audit recognizes the key literals as translated.
  wf: t,
  params,
  endpoints,
  errors,
  onParamChange,
}: {
  wf: Wf;
  params: Record<string, string>;
  endpoints: WebhookEndpointsPage | undefined;
  errors: Record<string, string>;
  onParamChange: (key: string, value: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    !(params.endpointId ?? "").trim() && ((params.url ?? "").trim() || (params.secret ?? "").trim())
      ? "custom"
      : "registry"
  );

  const switchMode = (next: Mode) => {
    if (next === mode) {
      return;
    }
    setMode(next);
    if (next === "registry") {
      onParamChange("url", "");
      onParamChange("secret", "");
    } else {
      onParamChange("endpointId", "");
    }
  };

  const endpointList = endpoints?.endpoints ?? [];
  const hasEndpoints = endpointList.length > 0;
  // The picker holds one page; a registry bigger than that must say so rather than
  // silently hide endpoints beyond the cap.
  const moreThanListed = (endpoints?.total ?? 0) > endpointList.length;

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-fill-subtle/40 p-3">
      <div className="inline-flex items-center gap-1 rounded-lg border border-border-default p-0.5">
        <Button
          type="button"
          size="xs"
          variant={mode === "registry" ? "secondary" : "ghost"}
          onClick={() => switchMode("registry")}
        >
          {t("webhookModeRegistry")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant={mode === "custom" ? "secondary" : "ghost"}
          onClick={() => switchMode("custom")}
        >
          {t("webhookModeCustom")}
        </Button>
      </div>

      {mode === "registry" ? (
        <div className="space-y-1.5 text-sm">
          <Label htmlFor="wf-param-endpointId" className="text-secondary">
            {t("paramWebhookEndpoint")}
          </Label>
          {hasEndpoints ? (
            <Select
              ariaLabel={t("paramWebhookEndpoint")}
              value={(params.endpointId ?? "").trim() || null}
              placeholder={t("webhookEndpointPlaceholder")}
              onValueChange={(value) => onParamChange("endpointId", value ?? "")}
            >
              {endpointList.map((endpoint) => (
                <SelectItem
                  key={endpoint.id}
                  value={endpoint.id}
                  disabled={endpoint.status !== "active"}
                >
                  {endpoint.status === "active"
                    ? endpoint.label
                    : `${endpoint.label}${t("webhookEndpointDisabledSuffix")}`}
                </SelectItem>
              ))}
            </Select>
          ) : (
            <p className="text-xs text-secondary">
              {t("webhookNoEndpoints")}{" "}
              <Link
                href="/dashboard/webhooks"
                className="text-primary underline underline-offset-2"
              >
                {t("webhookManageEndpoints")}
              </Link>
            </p>
          )}
          {hasEndpoints && moreThanListed ? (
            <p className="text-xs text-secondary">
              {t("webhookMoreEndpoints", { count: endpointList.length })}{" "}
              <Link
                href="/dashboard/webhooks"
                className="text-primary underline underline-offset-2"
              >
                {t("webhookManageEndpoints")}
              </Link>
            </p>
          ) : null}
          {errors.endpointId ? (
            <span className="text-xs text-error">{errors.endpointId}</span>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 text-sm">
            <Label htmlFor="wf-param-url" className="text-secondary">
              {t("paramWebhookUrl")}
              <span className="text-error"> *</span>
            </Label>
            <Input
              id="wf-param-url"
              type="text"
              inputMode="url"
              spellCheck={false}
              maxLength={2_000}
              value={params.url ?? ""}
              onChange={(event) => onParamChange("url", event.target.value)}
            />
            {errors.url ? <span className="text-xs text-error">{errors.url}</span> : null}
          </div>
          <div className="space-y-1.5 text-sm">
            <Label htmlFor="wf-param-secret" className="text-secondary">
              {t("paramSecret")}
            </Label>
            <Input
              id="wf-param-secret"
              type="password"
              autoComplete="off"
              maxLength={200}
              value={params.secret ?? ""}
              onChange={(event) => onParamChange("secret", event.target.value)}
            />
            {errors.secret ? <span className="text-xs text-error">{errors.secret}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
