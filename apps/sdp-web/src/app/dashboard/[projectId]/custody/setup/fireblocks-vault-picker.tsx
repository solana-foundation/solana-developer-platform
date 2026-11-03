"use client";

import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { useId, useRef, useState, useTransition } from "react";
import { z } from "zod";
import { useTranslations } from "@/i18n/provider";
import { useZodForm } from "@/lib/use-zod-form";
import { type FireblocksVault, loadFireblocksVaultsAction } from "./fireblocks-csr-actions";

const vaultSelectionSchema = z.object({
  apiKey: z.string().trim().min(1).max(256),
  selected: z
    .array(z.string().regex(/^\d{1,100}$/))
    .min(1)
    .max(20),
});

interface VaultPickerProps {
  signingKeyId: string;
  disabled?: boolean;
  multiple: boolean;
  onReadyChange: (ready: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  primaryVaultId?: string;
}

function useVaultPicker({
  signingKeyId,
  disabled,
  multiple,
  onReadyChange,
  onPendingChange,
  primaryVaultId,
}: VaultPickerProps) {
  const t = useTranslations();
  const form = useZodForm(vaultSelectionSchema, { apiKey: "", selected: [] });
  const { apiKey, selected } = form.values;
  const selectedIds = new Set(selected);
  const [vaults, setVaults] = useState<FireblocksVault[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const ready = !disabled && !pending && loaded && selected.length > 0;
  const load = (after?: string) => {
    const current = ++generation.current;
    setError(null);
    onReadyChange(false);
    onPendingChange?.(true);
    if (!after) {
      setLoaded(false);
      form.setField("selected", []);
      setVaults([]);
      setNextCursor(null);
    }
    startTransition(async () => {
      let nextSelected = after ? selected : [];
      try {
        const result = await loadFireblocksVaultsAction({
          signingKeyId,
          apiKey: apiKey.trim(),
          after,
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
        if (primaryVaultId && result.vaults.some((vault) => vault.id === primaryVaultId)) {
          nextSelected = [primaryVaultId];
        }
        form.setField("selected", nextSelected);
      } catch {
        if (generation.current === current) setError(t("DashboardCustody.fireblocksVaultsFailed"));
      } finally {
        if (generation.current === current) {
          onReadyChange(vaultSelectionSchema.safeParse({ apiKey, selected: nextSelected }).success);
          onPendingChange?.(false);
        }
      }
    });
  };
  function changeApiUser(value: string) {
    generation.current++;
    form.setFields({ apiKey: value, selected: [] });
    onReadyChange(false);
    setVaults([]);
    setNextCursor(null);
    setLoaded(false);
    setError(null);
  }
  function chooseVault(vaultId: string, checked: boolean) {
    let choices = selected.filter((value) => value !== vaultId);
    if (checked) choices = multiple ? [...selected, vaultId] : [vaultId];
    form.setField("selected", choices);
    onReadyChange(vaultSelectionSchema.safeParse({ apiKey, selected: choices }).success);
  }
  return {
    form,
    apiKey,
    selected,
    selectedIds,
    vaults,
    nextCursor,
    loaded,
    error,
    pending,
    ready,
    load,
    changeApiUser,
    chooseVault,
  };
}

export function FireblocksVaultPicker(props: VaultPickerProps) {
  const { disabled, multiple, primaryVaultId } = props;
  const t = useTranslations();
  const id = useId();
  const model = useVaultPicker(props);
  const { apiKey, selected, loaded, error, pending, ready, load, changeApiUser } = model;
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
          onChange={(event) => changeApiUser(event.target.value)}
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
        <LoadedVaults
          model={model}
          multiple={multiple}
          disabled={disabled}
          primaryVaultId={primaryVaultId}
          name={`${id}-vault-choice`}
        />
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

function LoadedVaults({
  model,
  multiple,
  disabled,
  primaryVaultId,
  name,
}: {
  model: ReturnType<typeof useVaultPicker>;
  multiple: boolean;
  disabled?: boolean;
  primaryVaultId?: string;
  name: string;
}) {
  const t = useTranslations();
  const { vaults, pending, selectedIds, selected, chooseVault, nextCursor, load } = model;
  return (
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
          <VaultChoice
            key={vault.id}
            vault={vault}
            multiple={multiple}
            disabled={disabled || pending}
            selectedIds={selectedIds}
            primaryVaultId={primaryVaultId}
            primarySelection={selected[0]}
            onChange={(checked) => chooseVault(vault.id, checked)}
            name={name}
          />
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
  );
}

function VaultChoice({
  vault,
  multiple,
  disabled,
  selectedIds,
  primaryVaultId,
  primarySelection,
  onChange,
  name,
}: {
  vault: FireblocksVault;
  multiple: boolean;
  disabled?: boolean;
  selectedIds: ReadonlySet<string>;
  primaryVaultId?: string;
  primarySelection?: string;
  onChange: (checked: boolean) => void;
  name: string;
}) {
  const t = useTranslations();
  const checked = selectedIds.has(vault.id);
  const unavailable =
    disabled ||
    (!multiple && primaryVaultId !== undefined && primaryVaultId !== vault.id) ||
    (multiple && selectedIds.size >= 20 && !checked);
  return (
    <label className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-4 py-3 text-sm last:border-b-0">
      <input
        type={multiple ? "checkbox" : "radio"}
        name={name}
        value={vault.id}
        checked={checked}
        disabled={unavailable}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 shrink-0 accent-current"
      />
      <span className="min-w-0 break-words">
        <span className="block text-primary">{vault.name}</span>
        {vault.id === (primaryVaultId ?? primarySelection) ? (
          <span className="block text-tertiary">
            {t("DashboardCustody.fireblocksCredentialVault")}
          </span>
        ) : null}
        <span className="block text-tertiary">
          {t("DashboardCustody.fireblocksVaultReference", { id: vault.id })}
        </span>
      </span>
    </label>
  );
}
