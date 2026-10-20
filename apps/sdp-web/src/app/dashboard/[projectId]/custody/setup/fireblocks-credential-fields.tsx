"use client";

import { assertNever } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { DownloadIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

interface RegistrationProps {
  disabled?: boolean;
  multiple?: boolean;
  primaryVaultId?: string;
  onReadyChange?: (ready: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}
function csrButtonLabel(
  ready: boolean,
  generating: boolean,
  t: ReturnType<typeof useTranslations>
) {
  let action: "generate" | "download" | "generating" = ready ? "download" : "generate";
  if (generating) action = "generating";
  switch (action) {
    case "generate":
      return t("DashboardCustody.fireblocksCsrGenerate");
    case "download":
      return t("DashboardCustody.fireblocksCsrDownload");
    case "generating":
      return t("DashboardCustody.fireblocksCsrGenerating");
    default:
      return assertNever(action);
  }
}
function useRegistration({ onReadyChange, onPendingChange }: RegistrationProps) {
  const t = useTranslations();
  const [csr, setCsr] = useState<FireblocksCsr | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [vaultsPending, setVaultsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expired = csr !== null && Date.parse(csr.expiresAt) <= now;
  const ready = csr !== null && !expired && !loading && !generating;
  useEffect(() => {
    let active = true;
    async function load() {
      onPendingChange?.(true);
      onReadyChange?.(false);
      try {
        const result = await loadFireblocksCsrAction();
        if (!active) return;
        if (result.status === "success") {
          setCsr(result.csr);
          setNow(Date.now());
        } else setError(result.message);
      } catch {
        if (active) setError(t("DashboardCustody.fireblocksCsrFailed"));
      } finally {
        if (active) {
          setLoading(false);
          onPendingChange?.(false);
        }
      }
    }
    void load();
    return () => {
      active = false;
      onPendingChange?.(false);
    };
  }, [onPendingChange, onReadyChange, t]);
  useEffect(() => {
    if (!csr) return;
    const remaining = Date.parse(csr.expiresAt) - Date.now();
    const timeout = setTimeout(
      () => {
        setNow(Date.now());
        onReadyChange?.(false);
      },
      Math.max(0, remaining)
    );
    return () => clearTimeout(timeout);
  }, [csr, onReadyChange]);
  const vaultPendingChanged = useCallback(
    (pending: boolean) => {
      setVaultsPending(pending);
      onPendingChange?.(pending);
    },
    [onPendingChange]
  );
  const vaultReadyChanged = useCallback(
    (vaultsReady: boolean) => {
      onReadyChange?.(vaultsReady && csr !== null && Date.parse(csr.expiresAt) > Date.now());
    },
    [csr, onReadyChange]
  );
  const generate = async () => {
    setGenerating(true);
    onPendingChange?.(true);
    onReadyChange?.(false);
    setError(null);
    try {
      requestKey.current ??= crypto.randomUUID();
      const result = await generateFireblocksCsrAction(requestKey.current);
      if (result.status !== "success" || !result.csr) {
        setError(
          result.status === "error" ? result.message : t("DashboardCustody.fireblocksCsrFailed")
        );
        return;
      }
      setCsr(result.csr);
      setNow(Date.now());
      requestKey.current = crypto.randomUUID();
      downloadCsr(result.csr);
    } catch {
      setError(t("DashboardCustody.fireblocksCsrFailed"));
    } finally {
      setGenerating(false);
      onPendingChange?.(false);
    }
  };
  return {
    csr,
    ready,
    loading,
    generating,
    vaultsPending,
    error,
    expired,
    generate,
    vaultPendingChanged,
    vaultReadyChanged,
  };
}
export function FireblocksCredentialFields(props: RegistrationProps) {
  const { disabled, multiple = true, primaryVaultId } = props;
  const t = useTranslations();
  const {
    csr,
    ready,
    loading,
    generating,
    vaultsPending,
    error,
    expired,
    generate,
    vaultPendingChanged,
    vaultReadyChanged,
  } = useRegistration(props);
  return (
    <div className="grid gap-6">
      <input type="hidden" name="signingKeyId" value={ready && csr ? csr.id : ""} />
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
          disabled={disabled || loading || generating || vaultsPending}
          onClick={() => (ready && csr ? downloadCsr(csr) : void generate())}
          iconLeft={
            generating ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
            ) : (
              <DownloadIcon className="size-4" aria-hidden />
            )
          }
        >
          {csrButtonLabel(ready, generating, t)}
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
        onReadyChange={vaultReadyChanged}
        onPendingChange={vaultPendingChanged}
        primaryVaultId={primaryVaultId}
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
