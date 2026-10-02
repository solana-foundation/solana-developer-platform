"use client";

import { LockIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { RecordBlock, RecordRow } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getTokenTypeLabel } from "../../issuance-token-fields";
import { MetadataSigner } from "./metadata-signer";
import { accessControlLabel, shortAddress, type TokenTabProps } from "./token-page.shared";
import { TokenSaveFooter } from "./token-save-footer";

const CURRENCIES = ["USD", "EUR", "GBP"] as const;
const NO_CURRENCY = "none";
const NUMERIC = "numeric";
const URL_PLACEHOLDER = "https://";
const LOGO_PLACEHOLDER = "https://…/logo.png";
// The draft fields this tab edits, named once so the JSX carries no string ids.
const F = {
  name: "name",
  symbol: "symbol",
  decimals: "decimals",
  maxSupply: "maxSupply",
  desc: "description",
  website: "website",
  imageUrl: "imageUrl",
  issuerName: "issuerName",
} as const;

type EditableField = (typeof F)[keyof typeof F];

type DetailsFormProps = Pick<TokenTabProps, "form">;

/** "Not set", quieter than a set value. */
function NotSet() {
  const t = useTranslations();
  return <span className="text-tertiary">{t("DashboardIssuance.newDesign.notSet")}</span>;
}

/**
 * What SDP keeps about the token: its name and terms, its issuer and currency, and how it
 * runs. Everything here stays in SDP; Public information decides what is published.
 */
export function TokenDetailsTab({ token, ops, form }: TokenTabProps) {
  const t = useTranslations();
  const canEdit = useDashboardWorkspace().dashboardAccess.capabilities.canManageTokenWrite;
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="grid gap-12 @3xl:grid-cols-[minmax(0,1fr)_260px]">
        <RecordBlock>
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-4 [&>button]:-my-1 [&>button]:[--button-height-md:1.875rem]">
            <h2 className="flex items-center gap-1 text-subheading font-medium text-primary">
              {t("DashboardIssuance.newDesign.details.about")}
              <InfoHint text={t("DashboardIssuance.newDesign.details.aboutHint")} />
            </h2>
            <DetailsEditAction
              editing={editing}
              canEdit={canEdit}
              saving={form.saving}
              onEdit={() => setEditing(true)}
            />
          </div>
          {editing ? (
            <div className="flex flex-col gap-6">
              <DetailsEdit token={token} form={form} />
            </div>
          ) : (
            <DetailsView token={token} form={form} />
          )}
        </RecordBlock>
        <OperationalBlock token={token} ops={ops} form={form} />
      </div>
      {editing ? (
        <DetailsSaveFooter ops={ops} form={form} onDone={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

/** "Editing" while the form is open, otherwise the way into it for those who may edit. */
function DetailsEditAction({
  editing,
  canEdit,
  saving,
  onEdit,
}: {
  editing: boolean;
  canEdit: boolean;
  saving: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations();
  if (editing) {
    return (
      <span className="text-meta text-secondary">
        {t("DashboardIssuance.newDesign.details.editing")}
      </span>
    );
  }
  if (!canEdit) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      iconLeft={<PencilIcon aria-hidden="true" />}
      disabled={saving}
      onClick={onEdit}
    >
      {t("DashboardIssuance.newDesign.details.editSettings")}
    </Button>
  );
}

/** The saved details, read only. */
function DetailsView({ token, form }: Pick<TokenTabProps, "token" | "form">) {
  const t = useTranslations();
  const locale = useLocale();
  const { draft } = form;
  const lockedHint = token.mintAddress
    ? t("DashboardIssuance.newDesign.details.lockedWithMint")
    : undefined;
  return (
    <>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.details.name")}>
          {draft.name || <NotSet />}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.symbol")} hint={lockedHint}>
          {draft.symbol}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.decimals")} hint={lockedHint}>
          {draft.decimals}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.maximumSupply")}>
          {draft.maxSupply ? formatDecimalAmount(draft.maxSupply, locale) : <NotSet />}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.description")}>
          <span className="max-w-[40em] text-right whitespace-normal">
            {draft.description || <NotSet />}
          </span>
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.website")}>
          <span className="truncate">{draft.website || <NotSet />}</span>
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.logoUrl")}>
          <span className="truncate">{draft.imageUrl || <NotSet />}</span>
        </RecordRow>
      </dl>
      <h3 className="mt-12 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.financial")}
      </h3>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.details.issuerName")}>
          {draft.issuerName || <NotSet />}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.currency")}>
          {draft.pegCurrency || t("DashboardIssuance.newDesign.details.noCurrency")}
        </RecordRow>
      </dl>
    </>
  );
}

/** The details as a form; what the mint fixes stays locked. */
function DetailsEdit({ token, form }: Pick<TokenTabProps, "token" | "form">) {
  const t = useTranslations();
  const deployed = Boolean(token.mintAddress);
  const decimalsLocked = deployed || token.template === "stablecoin";
  return (
    <>
      <DetailsField
        form={form}
        name={F.name}
        label={t("DashboardIssuance.newDesign.details.name")}
      />
      <div className="flex flex-col gap-2">
        <div className="grid gap-4 @xl:grid-cols-2">
          <DetailsField
            form={form}
            name={F.symbol}
            label={t("DashboardIssuance.newDesign.details.symbol")}
            locked={deployed}
          />
          <DetailsField
            form={form}
            name={F.decimals}
            label={t("DashboardIssuance.newDesign.details.decimals")}
            locked={decimalsLocked}
            inputMode={NUMERIC}
          />
        </div>
        {deployed ? (
          <p className="text-meta text-tertiary">
            {t("DashboardIssuance.newDesign.details.symbolDecimalsLocked")}
          </p>
        ) : token.template === "stablecoin" ? (
          <p className="text-meta text-tertiary">
            {t("DashboardIssuance.draftForm.stableDecimals")}
          </p>
        ) : null}
      </div>
      <DetailsField
        form={form}
        name={F.maxSupply}
        label={t("DashboardIssuance.newDesign.details.maximumSupply")}
        locked={form.supplyLocked}
        inputMode={NUMERIC}
        placeholder={t("DashboardIssuance.newDesign.overview.noCap")}
      />
      <DetailsField
        form={form}
        name={F.desc}
        label={t("DashboardIssuance.newDesign.details.description")}
        placeholder={t("DashboardIssuance.newDesign.draft.descriptionPlaceholder")}
      />
      <DetailsField
        form={form}
        name={F.website}
        label={t("DashboardIssuance.newDesign.details.website")}
        placeholder={URL_PLACEHOLDER}
      />
      <DetailsField
        form={form}
        name={F.imageUrl}
        label={t("DashboardIssuance.newDesign.details.logoUrl")}
        placeholder={LOGO_PLACEHOLDER}
      />
      <h3 className="mt-12 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.financial")}
      </h3>
      <div className="grid gap-4 @xl:grid-cols-2">
        <DetailsField
          form={form}
          name={F.issuerName}
          label={t("DashboardIssuance.newDesign.details.issuerName")}
          placeholder={t("DashboardIssuance.newDesign.draft.issuerPlaceholder")}
        />
        <CurrencyField form={form} />
      </div>
    </>
  );
}

/** One draft field: its input, or its value when locked, and its error once shown. */
function DetailsField({
  form,
  name,
  label,
  placeholder,
  locked,
  hint,
  inputMode,
}: DetailsFormProps & {
  name: EditableField;
  label: string;
  placeholder?: string;
  locked?: boolean;
  hint?: string;
  inputMode?: "numeric";
}) {
  const t = useTranslations();
  const { draft, updateDraft, saving, errors, showErrors } = form;
  const id = `token-details-${name}`;
  const value = draft[name];
  const error = showErrors ? (errors as Partial<Record<string, string>>)[name] : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Label
        htmlFor={locked ? undefined : id}
        className="flex items-center gap-1 text-meta font-normal text-secondary"
      >
        {label}
        {hint ? <InfoHint text={hint} /> : null}
        {locked ? (
          <LockIcon
            aria-label={t("DashboardIssuance.newDesign.details.locked")}
            className="size-3 text-tertiary"
          />
        ) : null}
      </Label>
      {locked ? (
        <span className="flex h-9 items-center border-b border-border-default px-0.5 text-body text-secondary">
          {value || <NotSet />}
        </span>
      ) : (
        <Input
          id={id}
          value={value}
          size="xl"
          inputMode={inputMode}
          placeholder={placeholder}
          disabled={saving}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          onChange={(event) => updateDraft({ [name]: event.currentTarget.value })}
        />
      )}
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  );
}

/** The currency the token is pegged to, or none. */
function CurrencyField({ form }: DetailsFormProps) {
  const t = useTranslations();
  const { draft, updateDraft, saving } = form;
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-meta font-normal text-secondary">
        {t("DashboardIssuance.newDesign.details.currency")}
      </Label>
      <Select
        ariaLabel={t("DashboardIssuance.newDesign.details.currency")}
        value={draft.pegCurrency || NO_CURRENCY}
        disabled={saving}
        onValueChange={(value) =>
          updateDraft({ pegCurrency: !value || value === NO_CURRENCY ? "" : value })
        }
      >
        {CURRENCIES.map((currency) => (
          <SelectItem key={currency} value={currency}>
            {currency}
          </SelectItem>
        ))}
        <SelectItem value={NO_CURRENCY}>
          {t("DashboardIssuance.newDesign.details.noCurrency")}
        </SelectItem>
      </Select>
    </div>
  );
}

/** How the token runs: its signer, template and access control. */
function OperationalBlock({ token, ops, form }: Pick<TokenTabProps, "token" | "ops" | "form">) {
  const t = useTranslations();
  const signingWallet = ops.authorityWallets.find(
    (wallet) => wallet.id === (token.signingCustodyWalletId ?? form.draft.signingWalletId)
  );
  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.details.operational")}>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.signingWallet")}>
          {signingWallet?.label?.trim() || shortAddress(signingWallet?.publicKey) || <NotSet />}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.template")}>
          {getTokenTypeLabel(token.template, t)}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.accessControl")}>
          {accessControlLabel(ops.accessControlMode, t)}
        </RecordRow>
      </dl>
    </RecordBlock>
  );
}

/** Saving or discarding the open form; either closes it. */
function DetailsSaveFooter({
  ops,
  form,
  onDone,
}: Pick<TokenTabProps, "ops" | "form"> & { onDone: () => void }) {
  const t = useTranslations();
  return (
    <TokenSaveFooter
      note={t("DashboardIssuance.newDesign.details.nothingSaved")}
      saving={form.saving}
      saveDisabled={
        !form.dirty ||
        Boolean(form.requiresMetadataSigner && ops.metadataSignerSelection.unavailableReason)
      }
      errorCount={form.showErrors ? form.errorCount : 0}
      onDiscard={() => {
        form.discard();
        onDone();
      }}
      onSave={async () => {
        if (await form.save()) onDone();
      }}
      signer={form.requiresMetadataSigner ? <MetadataSigner ops={ops} form={form} /> : null}
    />
  );
}
