"use client";

import { Button } from "@sdp/ui/button";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { custodyQueryKeys } from "@/app/(session)/dashboard/[projectId]/wallets/custody-query-key";
import { useTranslations } from "@/i18n/provider";
import { fetchPendingFireblocksCsr } from "./fireblocks-csr.data";
import { type FireblocksCsr, generateFireblocksCsrAction } from "./fireblocks-csr-actions";
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
function useRegistration({ onReadyChange, onPendingChange }: RegistrationProps) {
  const t = useTranslations();
  const [expiredCsrId, setExpiredCsrId] = useState<string | null>(null);
  const {
    data,
    error: readError,
    isValidating: loading,
    mutate,
  } = useSWR(custodyQueryKeys.pendingFireblocksCsr(), fetchPendingFireblocksCsr, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
    // Every mount reads again: a rejected attempt remounts these fields, and the registration
    // it used is claimed by then, so a cached answer would offer a registration that cannot connect.
    dedupingInterval: 0,
  });
  // A failed read leaves the previous answer in the cache, and a rejected attempt may have
  // claimed that registration: only a read that succeeded names the one to use.
  const csr = data === undefined || readError !== undefined ? null : data.csr;
  const [generating, setGenerating] = useState(false);
  const [vaultsPending, setVaultsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readFailureCleared, setReadFailureCleared] = useState(false);
  const requestKey = useRef<string | null>(null);
  const expired = csr !== null && csr.id === expiredCsrId;
  const ready = csr !== null && !expired && !loading && !generating;
  useEffect(() => {
    onReadyChange?.(false);
  }, [onReadyChange]);
  useEffect(() => {
    if (!loading) return;
    onPendingChange?.(true);
    return () => onPendingChange?.(false);
  }, [loading, onPendingChange]);
  useEffect(() => {
    if (!csr) return;
    const remaining = Date.parse(csr.expiresAt) - Date.now();
    const timeout = setTimeout(
      () => {
        setExpiredCsrId(csr.id);
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
    setReadFailureCleared(true);
    try {
      requestKey.current ??= crypto.randomUUID();
      const result = await generateFireblocksCsrAction(requestKey.current);
      if (result.status !== "success" || !result.csr) {
        setError(
          result.status === "error" ? result.message : t("DashboardCustody.fireblocksCsrFailed")
        );
        return;
      }
      await mutate({ csr: result.csr }, { revalidate: false });
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
    error:
      error ??
      (readError !== undefined && !readFailureCleared
        ? t("DashboardCustody.fireblocksCsrFailed")
        : null),
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
          disabled={disabled || loading || vaultsPending}
          loading={generating}
          onClick={() => (ready && csr ? downloadCsr(csr) : void generate())}
          iconLeft={<DownloadIcon className="size-4" aria-hidden />}
        >
          {ready
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
        onReadyChange={vaultReadyChanged}
        onPendingChange={vaultPendingChanged}
        primaryVaultId={primaryVaultId}
      />
      <details className="border-t border-border-default pt-4 text-sm">
        <summary className="cursor-pointer font-medium text-primary">
          {t("DashboardCustody.fireblocksTestingTitle")}
        </summary>
        <div className="mt-3 space-y-3 leading-5 text-secondary">
          <p>{t("DashboardCustody.fireblocksSigningRequirement")}</p>
          <p>{t("DashboardCustody.fireblocksIpRequirement")}</p>
          <p>{t("DashboardCustody.fireblocksTestingInstructions")}</p>
          <a
            href="https://developers.fireblocks.com/reference/interact-with-solana-programs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            {t("DashboardCustody.fireblocksSigningGuide")}
          </a>
        </div>
      </details>
    </div>
  );
}
