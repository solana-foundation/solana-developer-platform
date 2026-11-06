"use client";

import type { Action } from "@sdp/types/actions";
import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Textarea } from "@sdp/ui/textarea";
import { PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { EntityLink } from "@/components/entity-link";
import { RecordBlock, RecordRow } from "@/components/refresh-record";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDateTime } from "@/lib/date-format";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { type UpdateApiKeyInput, updateApiKeyAction } from "./actions";
import { ApiKeyAccessMatrix } from "./api-key-access-matrix";
import { buildEndpointWalletPayload } from "./api-key-authoring";
import {
  type ApiKeyExpiryChoice,
  ApiKeyExpiryField,
  ApiKeyField,
  ApiKeyWalletPicker,
  resolveExpiryChoice,
} from "./api-key-form-parts";
import { ApiKeyGrantPicker } from "./api-key-grant-picker";
import type { ApiKeyDetails } from "./api-key-presentation";

/** Saves one section's fields, refreshes the record and closes the section's editor. */
function useSectionSave(keyId: string, onSaved: () => void) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return {
    saving,
    error,
    clearError: () => setError(null),
    save: (input: UpdateApiKeyInput) =>
      startSaving(async () => {
        const result = await updateApiKeyAction(keyId, input);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(null);
        onSaved();
        router.refresh();
      }),
  };
}

/** A record part that edits in place: Edit swaps its body for a form with Save and Discard. */
function EditableBlock({
  title,
  hint,
  canEdit,
  editing,
  onEdit,
  view,
  form,
}: {
  title: string;
  hint?: string;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  view: ReactNode;
  form: ReactNode;
}) {
  const t = useTranslations();
  return (
    <RecordBlock
      title={title}
      hint={hint}
      aside={
        editing ? (
          <span className="text-meta text-secondary">
            {t("DashboardCustody.apiKeyPage.editing")}
          </span>
        ) : canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            iconLeft={<PencilIcon className="size-4" />}
          >
            {t("DashboardCustody.apiKeyPage.edit")}
          </Button>
        ) : null
      }
    >
      {editing ? form : view}
    </RecordBlock>
  );
}

function SectionActions({
  saveLabel,
  saving,
  disabled,
  error,
  onSave,
  onDiscard,
}: {
  saveLabel: string;
  saving: boolean;
  disabled?: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} loading={saving} disabled={disabled}>
          {saveLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
          {t("DashboardCustody.apiKeyPage.discard")}
        </Button>
      </div>
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  );
}

export function ApiKeyAccessSection({
  apiKey,
  offered,
  canEdit,
}: {
  apiKey: ApiKeyDetails;
  offered: readonly Action[];
  canEdit: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [grants, setGrants] = useState<Action[]>(apiKey.grants);
  const section = useSectionSave(apiKey.id, () => setEditing(false));
  const discard = () => {
    setGrants(apiKey.grants);
    section.clearError();
    setEditing(false);
  };
  return (
    <EditableBlock
      title={t("DashboardCustody.access")}
      hint={t("DashboardCustody.apiKeyPage.accessHint")}
      canEdit={canEdit}
      editing={editing}
      onEdit={() => setEditing(true)}
      view={<ApiKeyAccessMatrix grants={apiKey.grants} offered={offered} />}
      form={
        <div className="flex flex-col gap-4">
          <ApiKeyGrantPicker offered={offered} grants={grants} touched onChange={setGrants} />
          <SectionActions
            saveLabel={t("DashboardCustody.apiKeyPage.saveAccess")}
            saving={section.saving}
            disabled={grants.length === 0}
            error={section.error}
            onSave={() => section.save({ grants })}
            onDiscard={discard}
          />
        </div>
      }
    />
  );
}

function walletName(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

function SigningWalletRows({ wallets }: { wallets: PaymentsDashboardWallet[] }) {
  const t = useTranslations();
  const href = useProjectHref();
  if (wallets.length === 0) {
    return <p className="text-body text-tertiary">{t("DashboardCustody.apiKeyPage.noWallets")}</p>;
  }
  return (
    <ul>
      {wallets.map((wallet) => (
        <li
          key={wallet.id}
          className="flex min-w-0 items-center gap-3 border-b border-border-subtle py-3 last:border-b-0"
        >
          {wallet.provider ? <WalletProviderMark provider={wallet.provider} size="row" /> : null}
          <div className="min-w-0 flex-1">
            <EntityLink
              href={href(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`)}
              className="text-field text-primary"
            >
              {walletName(wallet)}
            </EntityLink>
            {wallet.provider ? (
              <p className="truncate text-body text-secondary">
                {formatCustodyProviderName(wallet.provider)}
              </p>
            ) : null}
          </div>
          {wallet.isRuntimeExecutionAllowed ? null : (
            <span className="flex shrink-0 items-center gap-1.5 text-meta text-warning">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {t("DashboardCustody.apiKeyPage.walletCannotSign")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ApiKeyWalletsSection({
  apiKey,
  wallets,
  canEdit,
}: {
  apiKey: ApiKeyDetails;
  wallets: PaymentsDashboardWallet[];
  canEdit: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [walletScope, setWalletScope] = useState<ApiKeyWalletScope>(apiKey.walletScope);
  const [walletIds, setWalletIds] = useState<string[]>(apiKey.walletIds);
  const section = useSectionSave(apiKey.id, () => setEditing(false));
  const signing =
    apiKey.walletScope === "all"
      ? wallets
      : wallets.filter((wallet) => apiKey.walletIds.includes(wallet.id));
  const discard = () => {
    setWalletScope(apiKey.walletScope);
    setWalletIds(apiKey.walletIds);
    section.clearError();
    setEditing(false);
  };
  return (
    <EditableBlock
      title={t("DashboardCustody.wallets")}
      hint={t("DashboardCustody.apiKeyPage.walletsHint")}
      canEdit={canEdit}
      editing={editing}
      onEdit={() => setEditing(true)}
      view={
        <div className="flex flex-col gap-2">
          {apiKey.walletScope === "all" ? (
            <p className="text-meta text-secondary">
              {t("DashboardCustody.apiKeyPage.allWalletsInProject")}
            </p>
          ) : null}
          <SigningWalletRows wallets={signing} />
        </div>
      }
      form={
        <div className="flex flex-col gap-4">
          <ApiKeyWalletPicker
            wallets={wallets}
            walletScope={walletScope}
            walletIds={walletIds}
            showRequired
            onChange={(scope, ids) => {
              setWalletScope(scope);
              setWalletIds(ids);
            }}
          />
          <SectionActions
            saveLabel={t("DashboardCustody.apiKeyPage.saveWallets")}
            saving={section.saving}
            disabled={walletScope === "selected" && walletIds.length === 0}
            error={section.error}
            onSave={() =>
              section.save({ wallets: buildEndpointWalletPayload(walletScope, walletIds) })
            }
            onDiscard={discard}
          />
        </div>
      }
    />
  );
}

export function ApiKeyDetailsSection({
  apiKey,
  canEdit,
  now,
}: {
  apiKey: ApiKeyDetails;
  canEdit: boolean;
  now: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const href = useProjectHref();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(apiKey.name);
  const [expiry, setExpiry] = useState<ApiKeyExpiryChoice>("keep");
  const [note, setNote] = useState(apiKey.description ?? "");
  const [allowedIps, setAllowedIps] = useState((apiKey.allowedIps ?? []).join("\n"));
  const section = useSectionSave(apiKey.id, () => setEditing(false));
  const discard = () => {
    setName(apiKey.name);
    setExpiry("keep");
    setNote(apiKey.description ?? "");
    setAllowedIps((apiKey.allowedIps ?? []).join("\n"));
    section.clearError();
    setEditing(false);
  };
  const save = () => {
    const ips = parseAllowedIps(allowedIps);
    section.save({
      name: name.trim(),
      description: note.trim() === "" ? null : note.trim(),
      // An empty allowlist clears it: the key may be used from any address.
      allowedIps: ips.length > 0 ? ips : null,
      expiresAt:
        expiry === "keep" ? undefined : resolveExpiryChoice(expiry, apiKey.expiresAt, Date.now()),
    });
  };
  const notSet = <span className="text-tertiary">{t("Shared.SharedComponents.notSet")}</span>;

  return (
    <EditableBlock
      title={t("DashboardCustody.apiKeyPage.details")}
      canEdit={canEdit}
      editing={editing}
      onEdit={() => setEditing(true)}
      view={
        <dl>
          <RecordRow label={t("DashboardCustody.prefix")}>
            <span className="font-mono">{apiKey.keyPrefix}</span>
          </RecordRow>
          <RecordRow label={t("DashboardCustody.apiKeyPage.keyId")}>
            <span className="truncate font-mono">{apiKey.id}</span>
            <span className="-my-1.5">
              <WalletMetadataCopyButton
                value={apiKey.id}
                label={t("DashboardCustody.apiKeyPage.keyId")}
                tooltip={apiKey.id}
              />
            </span>
          </RecordRow>
          <RecordRow label={t("DashboardCustody.expires")}>
            {apiKey.expiresAt
              ? formatDateTime(locale, timeZone, apiKey.expiresAt)
              : t("DashboardCustody.apiKeyPage.noExpiry")}
          </RecordRow>
          <RecordRow label={t("DashboardCustody.created")}>
            {formatDateTime(locale, timeZone, apiKey.createdAt)}
          </RecordRow>
          {apiKey.rotatedFrom ? (
            <RecordRow label={t("DashboardCustody.apiKeyPage.replaces")}>
              <EntityLink
                href={href(`/dashboard/api-keys/${encodeURIComponent(apiKey.rotatedFrom)}`)}
              >
                {apiKey.rotatedFrom}
              </EntityLink>
            </RecordRow>
          ) : null}
          <RecordRow label={t("DashboardCustody.apiKeyAllowedIps")}>
            {apiKey.allowedIps && apiKey.allowedIps.length > 0
              ? apiKey.allowedIps.join(", ")
              : t("DashboardCustody.apiKeyAllowedIpsAny")}
          </RecordRow>
          <RecordRow label={t("DashboardCustody.apiKeyPage.note")}>
            {apiKey.description ?? notSet}
          </RecordRow>
        </dl>
      }
      form={
        <div className="flex flex-col gap-5">
          <ApiKeyField label={t("DashboardCustody.name")} htmlFor="api-key-name">
            <Input
              id="api-key-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </ApiKeyField>
          <ApiKeyField label={t("DashboardCustody.expires")} htmlFor="api-key-expiry">
            <ApiKeyExpiryField
              id="api-key-expiry"
              choice={expiry}
              current={apiKey.expiresAt}
              now={now}
              onChange={setExpiry}
            />
          </ApiKeyField>
          <ApiKeyField label={t("DashboardCustody.apiKeyPage.note")} htmlFor="api-key-note">
            <Textarea
              id="api-key-note"
              value={note}
              maxLength={500}
              rows={2}
              placeholder={t("DashboardCustody.apiKeyPage.notePlaceholder")}
              onChange={(event) => setNote(event.target.value)}
            />
          </ApiKeyField>
          <ApiKeyField
            label={t("DashboardCustody.apiKeyAllowedIpsLabel")}
            hint={t("DashboardCustody.apiKeyAllowedIpsHelper")}
            htmlFor="api-key-allowed-ips"
          >
            <Textarea
              id="api-key-allowed-ips"
              value={allowedIps}
              rows={3}
              className="font-mono"
              onChange={(event) => setAllowedIps(event.target.value)}
            />
          </ApiKeyField>
          <SectionActions
            saveLabel={t("DashboardCustody.apiKeyPage.saveChanges")}
            saving={section.saving}
            disabled={name.trim() === ""}
            error={section.error}
            onSave={save}
            onDiscard={discard}
          />
        </div>
      }
    />
  );
}
