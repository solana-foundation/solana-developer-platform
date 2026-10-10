"use client";

import { DownloadIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import {
  type FireblocksCsr,
  generateFireblocksCsrAction,
  loadFireblocksCsrAction,
} from "./fireblocks-csr-actions";
import { FireblocksVaultPicker } from "./fireblocks-vault-picker";

function downloadCsr(csr: FireblocksCsr) {
  const url = URL.createObjectURL(new Blob([csr.csrPem], { type: "application/pkcs10" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `sdp-fireblocks-${csr.id}.csr`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FireblocksCredentialFields({
  disabled,
  multiple = true,
  onReadyChange,
}: {
  disabled?: boolean;
  multiple?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const t = useTranslations();
  const [csr, setCsr] = useState<FireblocksCsr | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [expired, setExpired] = useState(false);
  const [vaultsReady, setVaultsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadFireblocksCsrAction().then((result) => {
      if (cancelled) return;
      if (result.status === "success") setCsr(result.csr);
      else setError(result.message);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!csr) {
      setExpired(false);
      return;
    }
    const remaining = Date.parse(csr.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timeout = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timeout);
  }, [csr]);
  const ready = csr !== null && !expired && !loading && !generating;
  useEffect(() => {
    onReadyChange?.(ready && vaultsReady && !disabled);
  }, [onReadyChange, ready, vaultsReady, disabled]);
  const generate = async () => {
    setGenerating(true);
    setError(null);
    const result = await generateFireblocksCsrAction(requestKey);
    setGenerating(false);
    if (result.status !== "success" || !result.csr) {
      setError(
        result.status === "error" ? result.message : t("DashboardCustody.fireblocksCsrFailed")
      );
      return;
    }
    setCsr(result.csr);
    setRequestKey(crypto.randomUUID());
    downloadCsr(result.csr);
  };
  return (
    <div className="grid gap-6">
      <input type="hidden" name="signingKeyId" value={ready ? csr.id : ""} />
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardCustody.fireblocksRegisterTitle")}
        </h3>
        <p className="text-sm leading-5 text-secondary">
          {t("DashboardCustody.fireblocksRegisterDescription")}
        </p>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || loading || generating}
          onClick={() => (ready ? downloadCsr(csr) : void generate())}
          iconLeft={
            generating ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
            ) : (
              <DownloadIcon className="size-4" aria-hidden />
            )
          }
        >
          {generating
            ? t("DashboardCustody.fireblocksCsrGenerating")
            : ready
              ? t("DashboardCustody.fireblocksCsrDownload")
              : t("DashboardCustody.fireblocksCsrGenerate")}
        </Button>
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.fireblocksKeyStorage")}
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-5 text-secondary">
          <li>{t("DashboardCustody.fireblocksInstructionConsole")}</li>
          <li>{t("DashboardCustody.fireblocksInstructionEditor")}</li>
          <li>{t("DashboardCustody.fireblocksInstructionUpload")}</li>
          <li>{t("DashboardCustody.fireblocksInstructionApprove")}</li>
        </ol>

        {ready ? (
          <p role="status" className="text-sm text-secondary">
            {t("DashboardCustody.fireblocksCsrReady")}
          </p>
        ) : null}
        {expired ? (
          <p role="alert" className="text-sm text-error">
            {t("DashboardCustody.fireblocksCsrExpired")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        <a
          href="https://developers.fireblocks.com/docs/integrate-fireblocks-with-third-party-service-providers"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"
        >
          {t("DashboardCustody.fireblocksSetupGuide")}{" "}
          <ExternalLinkIcon className="size-3.5" aria-hidden />
        </a>
      </section>
      <FireblocksVaultPicker
        key={csr?.id ?? "pending"}
        signingKeyId={csr?.id ?? ""}
        disabled={disabled || !ready}
        multiple={multiple}
        onReadyChange={setVaultsReady}
      />
      <details className="border-t border-border-default pt-4 text-sm">
        <summary className="cursor-pointer font-medium text-primary">
          {t("DashboardCustody.fireblocksTestingTitle")}
        </summary>
        <div className="mt-3 space-y-3 leading-5 text-secondary">
          <p>{t("DashboardCustody.fireblocksRawRequirement")}</p>
          <p>{t("DashboardCustody.fireblocksIpRequirement")}</p>
          <p>{t("DashboardCustody.fireblocksTestingInstructions")}</p>
          <a
            href="https://developers.fireblocks.com/docs/raw-signing"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            {t("DashboardCustody.fireblocksRawGuide")}
          </a>
        </div>
      </details>
    </div>
  );
}
