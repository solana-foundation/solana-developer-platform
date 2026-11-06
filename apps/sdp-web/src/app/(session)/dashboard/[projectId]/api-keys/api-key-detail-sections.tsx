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
import { z } from "zod";
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
import { useZodForm } from "@/lib/use-zod-form";
import { type UpdateApiKeyInput, updateApiKeyAction } from "./actions";
import { ApiKeyAccessMatrix } from "./api-key-access-matrix";
import { buildEndpointWalletPayload } from "./api-key-authoring";
import { ApiKeyExpiryField, ApiKeyField, ApiKeyWalletPicker } from "./api-key-form-parts";
import { ApiKeyGrantPicker } from "./api-key-grant-picker";
import {
  type ApiKeyDetails,
  type ApiKeyExpiryChoice,
  resolveExpiryChoice,
} from "./api-key-presentation";

/** One section's part in the page's in-flight state: whether it is saving, told up to the page. */
export interface SectionFlow {
  /** A request anywhere on the page is in flight, so this section's controls wait. */
  busy: boolean;
  onPendingChange: (pending: boolean) => void;
}

/** Saves one section's fields, refreshes the record and closes the section's editor. */
function useSectionSave(keyId: string, flow: SectionFlow, onSaved: () => void) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return {
    saving,
    error,
    clearError: () => setError(null),
    save: (input: UpdateApiKeyInput) => {
      flow.onPendingChange(true);
      startSaving(async () => {
        const result = await updateApiKeyAction(keyId, input);
        flow.onPendingChange(false);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(null);
        onSaved();
        router.refresh();
      });
    },
  };
}

/** A record part that edits in place: Edit swaps its body for a form with Save and Discard. */
function EditableBlock({
  title,
  hint,
  canEdit,
  busy,
  editing,
  onEdit,
  view,
  form,
}: {
  title: string;
  hint?: string;
  canEdit: boolean;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  view: ReactNode;
  form: ReactNode;
}) {
  const t = useTranslations();
  const aside = (() => {
    if (editing) {
      return (
        <span className="text-meta text-secondary">{t("DashboardCustody.apiKeyPage.editing")}</span>
      );
    }
    if (!canEdit) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={onEdit}
        disabled={busy}
        iconLeft={<PencilIcon className="size-4" />}
      >
        {t("DashboardCustody.apiKeyPage.edit")}
      </Button>
    );
  })();
  return (
    <RecordBlock title={title} hint={hint} aside={aside}>
      {editing ? form : view}
    </RecordBlock>
  );
}

function SectionActions({
  saveLabel,
  saving,
  busy,
  disabled,
  error,
  onSave,
  onDiscard,
}: {
  saveLabel: string;
  saving: boolean;
  /** Another request on the page is in flight. */
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={disabled || (busy && !saving)}
        >
          {saveLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
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
  flow,
}: {
  apiKey: ApiKeyDetails;
  offered: readonly Action[];
  canEdit: boolean;
  flow: SectionFlow;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [grants, setGrants] = useState<Action[]>(apiKey.grants);
  const section = useSectionSave(apiKey.id, flow, () => setEditing(false));
  // Each open starts from the key as saved, so an earlier edit never rides along.
  const open = () => {
    setGrants(apiKey.grants);
    section.clearError();
    setEditing(true);
  };
  return (
    <EditableBlock
      title={t("DashboardCustody.access")}
      hint={t("DashboardCustody.apiKeyPage.accessHint")}
      canEdit={canEdit}
      busy={flow.busy}
      editing={editing}
      onEdit={open}
      view={<ApiKeyAccessMatrix grants={apiKey.grants} offered={offered} />}
      form={
        <div className="flex flex-col gap-4">
          <ApiKeyGrantPicker offered={offered} grants={grants} touched onChange={setGrants} />
          <SectionActions
            saveLabel={t("DashboardCustody.apiKeyPage.saveAccess")}
            saving={section.saving}
            busy={flow.busy}
            disabled={grants.length === 0}
            error={section.error}
            onSave={() => section.save({ grants })}
            onDiscard={() => setEditing(false)}
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
  flow,
}: {
  apiKey: ApiKeyDetails;
  wallets: PaymentsDashboardWallet[];
  canEdit: boolean;
  flow: SectionFlow;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [walletScope, setWalletScope] = useState<ApiKeyWalletScope>(apiKey.walletScope);
  const [walletIds, setWalletIds] = useState<string[]>(apiKey.walletIds);
  const section = useSectionSave(apiKey.id, flow, () => setEditing(false));
  const listedWalletIds = new Set(apiKey.walletIds);
  const signing =
    apiKey.walletScope === "all"
      ? wallets
      : wallets.filter((wallet) => listedWalletIds.has(wallet.id));
  const open = () => {
    setWalletScope(apiKey.walletScope);
    setWalletIds(apiKey.walletIds);
    section.clearError();
    setEditing(true);
  };
  return (
    <EditableBlock
      title={t("DashboardCustody.wallets")}
      hint={t("DashboardCustody.apiKeyPage.walletsHint")}
      canEdit={canEdit}
      busy={flow.busy}
      editing={editing}
      onEdit={open}
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
            busy={flow.busy}
            disabled={walletScope === "selected" && walletIds.length === 0}
            error={section.error}
            onSave={() =>
              section.save({ wallets: buildEndpointWalletPayload(walletScope, walletIds) })
            }
            onDiscard={() => setEditing(false)}
          />
        </div>
      }
    />
  );
}

const detailsFormSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiry: z.custom<ApiKeyExpiryChoice>(),
  note: z.string().trim().max(500),
  allowedIps: z.string(),
});

type DetailsFormValues = z.input<typeof detailsFormSchema>;

function detailsFromKey(apiKey: ApiKeyDetails): DetailsFormValues {
  return {
    name: apiKey.name,
    expiry: "keep",
    note: apiKey.description ?? "",
    allowedIps: (apiKey.allowedIps ?? []).join("\n"),
  };
}

export function ApiKeyDetailsSection({
  apiKey,
  canEdit,
  flow,
  now,
}: {
  apiKey: ApiKeyDetails;
  canEdit: boolean;
  flow: SectionFlow;
  now: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const href = useProjectHref();
  const [editing, setEditing] = useState(false);
  const form = useZodForm(detailsFormSchema, detailsFromKey(apiKey));
  const section = useSectionSave(apiKey.id, flow, () => setEditing(false));
  // Each open starts from the key as saved: a lifetime picked in an earlier edit would
  // otherwise be measured again from the next save and move the expiry.
  const open = () => {
    form.setFields(detailsFromKey(apiKey));
    section.clearError();
    setEditing(true);
  };
  const save = () => {
    const parsed = form.validate();
    if (!parsed.ok) return;
    const { name, expiry, note, allowedIps } = parsed.data;
    const ips = parseAllowedIps(allowedIps);
    section.save({
      name,
      description: note === "" ? null : note,
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
      busy={flow.busy}
      editing={editing}
      onEdit={open}
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
              value={form.values.name}
              maxLength={100}
              onChange={(event) => form.setField("name", event.target.value)}
            />
            {form.errors.name ? (
              <p className="text-meta text-error">{t("DashboardCustody.apiKeyNameRequired")}</p>
            ) : null}
          </ApiKeyField>
          <ApiKeyField label={t("DashboardCustody.expires")} htmlFor="api-key-expiry">
            <ApiKeyExpiryField
              id="api-key-expiry"
              choice={form.values.expiry}
              current={apiKey.expiresAt}
              now={now}
              onChange={(choice) => form.setField("expiry", choice)}
            />
          </ApiKeyField>
          <ApiKeyField label={t("DashboardCustody.apiKeyPage.note")} htmlFor="api-key-note">
            <Textarea
              id="api-key-note"
              value={form.values.note}
              maxLength={500}
              rows={2}
              placeholder={t("DashboardCustody.apiKeyPage.notePlaceholder")}
              onChange={(event) => form.setField("note", event.target.value)}
            />
          </ApiKeyField>
          <ApiKeyField
            label={t("DashboardCustody.apiKeyAllowedIpsLabel")}
            hint={t("DashboardCustody.apiKeyAllowedIpsHelper")}
            htmlFor="api-key-allowed-ips"
          >
            <Textarea
              id="api-key-allowed-ips"
              value={form.values.allowedIps}
              rows={3}
              className="font-mono"
              onChange={(event) => form.setField("allowedIps", event.target.value)}
            />
          </ApiKeyField>
          <SectionActions
            saveLabel={t("DashboardCustody.apiKeyPage.saveChanges")}
            saving={section.saving}
            busy={flow.busy}
            disabled={false}
            error={section.error}
            onSave={save}
            onDiscard={() => setEditing(false)}
          />
        </div>
      }
    />
  );
}
