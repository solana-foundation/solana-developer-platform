"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { type FireblocksVault, loadFireblocksVaultsAction } from "./fireblocks-csr-actions";

export function FireblocksVaultPicker({
  signingKeyId,
  disabled,
  multiple,
  onReadyChange,
}: {
  signingKeyId: string;
  disabled?: boolean;
  multiple: boolean;
  onReadyChange: (ready: boolean) => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [vaults, setVaults] = useState<FireblocksVault[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const ready = !disabled && !pending && loaded && selected.length > 0;
  useEffect(() => onReadyChange(ready), [onReadyChange, ready]);
  const load = (after?: string) => {
    const current = ++generation.current;
    setError(null);
    if (!after) {
      setLoaded(false);
      setSelected([]);
      setVaults([]);
      setNextCursor(null);
    }
    startTransition(async () => {
      try {
        const result = await loadFireblocksVaultsAction({
          signingKeyId,
          apiKey: apiKey.trim(),
          ...(after ? { after } : {}),
        });
        if (generation.current !== current) return;
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setVaults((previous) => [
          ...new Map(
            [...(after ? previous : []), ...result.vaults].map((vault) => [vault.id, vault])
          ).values(),
        ]);
        setNextCursor(result.nextCursor);
        setLoaded(true);
      } catch {
        if (generation.current === current) setError(t("DashboardCustody.fireblocksVaultsFailed"));
      }
    });
  };
  return (
    <section className="space-y-4 border-t border-border-default pt-5">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardCustody.fireblocksConnectTitle")}
      </h3>
      <div className="space-y-2">
        <Label htmlFor={`${id}-key`}>{t("DashboardCustody.providerFireblocksApiKey")}</Label>
        <Input
          id={`${id}-key`}
          name="apiKey"
          autoComplete="off"
          required
          disabled={disabled || pending}
          value={apiKey}
          placeholder={t("DashboardCustody.fireblocksApiKeyPlaceholder")}
          onChange={(event) => {
            generation.current++;
            setApiKey(event.target.value);
            setVaults([]);
            setSelected([]);
            setNextCursor(null);
            setLoaded(false);
            setError(null);
          }}
        />
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.fireblocksCopyApiUser")}
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || pending || !apiKey.trim()}
        onClick={() => load()}
      >
        {pending
          ? t("DashboardCustody.fireblocksVaultsLoading")
          : t("DashboardCustody.fireblocksVaultsLoad")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardCustody.fireblocksChooseVaults")}
          </h3>
          <p className="text-sm leading-5 text-secondary">
            {t(
              multiple
                ? "DashboardCustody.fireblocksVaultSelectionHelp"
                : "DashboardCustody.fireblocksRotationVaultHelp"
            )}
          </p>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-border-default">
            {vaults.map((vault) => (
              <label
                key={vault.id}
                className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-4 py-3 text-sm last:border-b-0"
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={`${id}-vault-choice`}
                  value={vault.id}
                  checked={selected.includes(vault.id)}
                  disabled={
                    disabled ||
                    pending ||
                    (multiple && selected.length >= 20 && !selected.includes(vault.id))
                  }
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? multiple
                          ? [...previous, vault.id]
                          : [vault.id]
                        : previous.filter((value) => value !== vault.id)
                    )
                  }
                  className="size-4 shrink-0 accent-current"
                />
                <span className="min-w-0 break-words">
                  <span className="block text-primary">{vault.name}</span>
                  <span className="block text-tertiary">
                    {t("DashboardCustody.fireblocksVaultReference", { id: vault.id })}
                  </span>
                </span>
              </label>
            ))}
            {vaults.length === 0 ? (
              <p className="p-4 text-sm text-secondary">
                {t("DashboardCustody.fireblocksVaultsEmpty")}
              </p>
            ) : null}
          </div>
          {nextCursor ? (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || pending}
              onClick={() => load(nextCursor)}
            >
              {t("DashboardCustody.fireblocksVaultsMore")}
            </Button>
          ) : null}
          <p role="status" className="text-sm text-secondary">
            {t("DashboardCustody.fireblocksVaultsSelected", { count: selected.length })}
          </p>
          {multiple ? (
            <p className="text-sm leading-5 text-tertiary">
              {t("DashboardCustody.fireblocksVaultLabels")}
            </p>
          ) : null}
        </div>
      ) : null}
      <input type="hidden" name="vaultAccountId" value={ready ? selected[0] : ""} />
      {multiple && ready
        ? selected.map((value) => (
            <input key={value} type="hidden" name="fireblocksVaultAccountIds" value={value} />
          ))
        : null}
      <p className="text-sm leading-5 text-tertiary">
        {t("DashboardCustody.fireblocksVerifyDescription")}
      </p>
    </section>
  );
}
