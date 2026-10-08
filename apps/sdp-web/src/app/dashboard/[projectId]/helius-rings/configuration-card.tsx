"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { createRingsConnection, type RingsSetupStatus } from "./helius-rings-configuration.data";

export function RingsConfigurationCard({
  setup,
  onConfigured,
}: {
  setup: RingsSetupStatus;
  onConfigured: () => Promise<void>;
}) {
  const t = useTranslations();
  const [name, setName] = useState("Helius devnet");
  const [solanaRpcUrl, setSolanaRpcUrl] = useState("");
  const [indexerUrl, setIndexerUrl] = useState("");
  const [proverUrl, setProverUrl] = useState("");
  const [ringRpcUrl, setRingRpcUrl] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiredUrlsPresent =
    solanaRpcUrl.trim() !== "" && indexerUrl.trim() !== "" && proverUrl.trim() !== "";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await createRingsConnection({
        name: name.trim(),
        solanaRpcUrl,
        indexerUrl,
        proverUrl,
        ...(ringRpcUrl.trim() ? { ringRpcUrl } : {}),
        allowInsecureHttp,
      });
      await onConfigured();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("DashboardHeliusRings.setup.failed"));
    } finally {
      setSaving(false);
    }
  }

  if (setup.source === "database" && setup.defaultConnection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardHeliusRings.setup.configuredTitle")}</CardTitle>
          <CardDescription>
            {t("DashboardHeliusRings.setup.configuredDescription", {
              name: setup.defaultConnection.name,
            })}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.setup.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.setup.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!setup.canManage ? (
          <Callout variant="warning">{t("DashboardHeliusRings.setup.adminRequired")}</Callout>
        ) : (
          <>
            {error ? (
              <Callout variant="danger" live>
                {error}
              </Callout>
            ) : null}
            <Field label={t("DashboardHeliusRings.setup.name")} value={name} onChange={setName} />
            <Field
              label={t("DashboardHeliusRings.setup.rpc")}
              value={solanaRpcUrl}
              onChange={setSolanaRpcUrl}
              type="url"
            />
            <Field
              label={t("DashboardHeliusRings.setup.indexer")}
              value={indexerUrl}
              onChange={setIndexerUrl}
              type="url"
            />
            <Field
              label={t("DashboardHeliusRings.setup.prover")}
              value={proverUrl}
              onChange={setProverUrl}
              type="url"
            />
            <Field
              label={t("DashboardHeliusRings.setup.ringRpc")}
              value={ringRpcUrl}
              onChange={setRingRpcUrl}
              type="url"
              required={false}
            />
            {setup.allowInsecureHttpAllowed ? (
              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={allowInsecureHttp}
                  onChange={(event) => setAllowInsecureHttp(event.currentTarget.checked)}
                />
                {t("DashboardHeliusRings.setup.allowHttp")}
              </label>
            ) : null}
            <Button
              onClick={() => void save()}
              disabled={saving || name.trim() === "" || !requiredUrlsPresent}
            >
              {saving
                ? t("DashboardHeliusRings.setup.saving")
                : t("DashboardHeliusRings.setup.save")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "url";
  required?: boolean;
}) {
  const id = `rings-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}
