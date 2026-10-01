"use client";

import { LockIcon, PencilIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { TokenSignerSelect } from "../token-signer-select";
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

/**
 * What SDP keeps about the token: its name and terms, its issuer and currency, and how it
 * runs. Everything here stays in SDP; Public information decides what is published.
 */
export function TokenDetailsTab({ token, ops, form }: TokenTabProps) {
  const t = useTranslations();
  const canEdit = useDashboardWorkspace().dashboardAccess.capabilities.canManageTokenWrite;
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const { draft, updateDraft, saving, errors, showErrors, supplyLocked } = form;
  const deployed = Boolean(token.mintAddress);
  const decimalsLocked = deployed || token.template === "stablecoin";
  const notSet = <span className="text-tertiary">{t("DashboardIssuance.newDesign.notSet")}</span>;
  const signingWallet = ops.authorityWallets.find(
    (wallet) => wallet.id === (token.signingCustodyWalletId ?? draft.signingWalletId)
  );
  const errorOf = (field: EditableField) =>
    showErrors ? (errors as Partial<Record<string, string>>)[field] : undefined;

  const field = (
    name: EditableField,
    label: string,
    options: { placeholder?: string; locked?: boolean; hint?: string; inputMode?: "numeric" } = {}
  ) => {
    const id = `token-details-${name}`;
    const value = draft[name];
    const error = errorOf(name);
    return (
      <div className="flex flex-col gap-2">
        <Label
          htmlFor={options.locked ? undefined : id}
          className="flex items-center gap-1 text-meta font-normal text-secondary"
        >
          {label}
          {options.hint ? <InfoHint text={options.hint} /> : null}
          {options.locked ? (
            <LockIcon
              aria-label={t("DashboardIssuance.newDesign.details.locked")}
              className="size-3 text-tertiary"
            />
          ) : null}
        </Label>
        {options.locked ? (
          <span className="flex h-9 items-center border-b border-border-default px-0.5 text-body text-secondary">
            {value || notSet}
          </span>
        ) : (
          <Input
            id={id}
            value={value}
            size="xl"
            inputMode={options.inputMode}
            placeholder={options.placeholder}
            disabled={saving}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            onChange={(event) => updateDraft({ [name]: event.currentTarget.value })}
          />
        )}
        {error ? <p className="text-meta text-error">{error}</p> : null}
      </div>
    );
  };

  const view = (
    <>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.details.name")}>
          {draft.name || notSet}
        </RecordRow>
        <RecordRow
          label={t("DashboardIssuance.newDesign.details.symbol")}
          hint={deployed ? t("DashboardIssuance.newDesign.details.lockedWithMint") : undefined}
        >
          {draft.symbol}
        </RecordRow>
        <RecordRow
          label={t("DashboardIssuance.newDesign.details.decimals")}
          hint={deployed ? t("DashboardIssuance.newDesign.details.lockedWithMint") : undefined}
        >
          {draft.decimals}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.maximumSupply")}>
          {draft.maxSupply ? formatDecimalAmount(draft.maxSupply, locale) : notSet}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.description")}>
          <span className="max-w-[40em] text-right whitespace-normal">
            {draft.description || notSet}
          </span>
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.website")}>
          <span className="truncate">{draft.website || notSet}</span>
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.logoUrl")}>
          <span className="truncate">{draft.imageUrl || notSet}</span>
        </RecordRow>
      </dl>
      <h3 className="mt-12 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.financial")}
      </h3>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.details.issuerName")}>
          {draft.issuerName || notSet}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.details.currency")}>
          {draft.pegCurrency || t("DashboardIssuance.newDesign.details.noCurrency")}
        </RecordRow>
      </dl>
    </>
  );

  const edit = (
    <>
      {field(F.name, t("DashboardIssuance.newDesign.details.name"))}
      <div className="flex flex-col gap-2">
        <div className="grid gap-4 @xl:grid-cols-2">
          {field(F.symbol, t("DashboardIssuance.newDesign.details.symbol"), { locked: deployed })}
          {field(F.decimals, t("DashboardIssuance.newDesign.details.decimals"), {
            locked: decimalsLocked,
            inputMode: NUMERIC,
          })}
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
      {field(F.maxSupply, t("DashboardIssuance.newDesign.details.maximumSupply"), {
        locked: supplyLocked,
        inputMode: NUMERIC,
        placeholder: t("DashboardIssuance.newDesign.overview.noCap"),
      })}
      {field(F.desc, t("DashboardIssuance.newDesign.details.description"), {
        placeholder: t("DashboardIssuance.newDesign.draft.descriptionPlaceholder"),
      })}
      {field(F.website, t("DashboardIssuance.newDesign.details.website"), {
        placeholder: URL_PLACEHOLDER,
      })}
      {field(F.imageUrl, t("DashboardIssuance.newDesign.details.logoUrl"), {
        placeholder: LOGO_PLACEHOLDER,
      })}
      <h3 className="mt-12 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.details.financial")}
      </h3>
      <div className="grid gap-4 @xl:grid-cols-2">
        {field(F.issuerName, t("DashboardIssuance.newDesign.details.issuerName"), {
          placeholder: t("DashboardIssuance.newDesign.draft.issuerPlaceholder"),
        })}
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
      </div>
    </>
  );

  return (
    <div className="flex flex-col">
      <div className="grid gap-12 @3xl:grid-cols-[minmax(0,1fr)_260px]">
        <RecordBlock>
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-4 [&>button]:-my-1 [&>button]:[--button-height-md:1.875rem]">
            <h2 className="flex items-center gap-1 text-subheading font-medium text-primary">
              {t("DashboardIssuance.newDesign.details.about")}
              <InfoHint text={t("DashboardIssuance.newDesign.details.aboutHint")} />
            </h2>
            {editing ? (
              <span className="text-meta text-secondary">
                {t("DashboardIssuance.newDesign.details.editing")}
              </span>
            ) : canEdit ? (
              <Button
                variant="outline"
                size="sm"
                iconLeft={<PencilIcon aria-hidden="true" />}
                disabled={saving}
                onClick={() => setEditing(true)}
              >
                {t("DashboardIssuance.newDesign.details.editSettings")}
              </Button>
            ) : null}
          </div>
          {editing ? <div className="flex flex-col gap-6">{edit}</div> : view}
        </RecordBlock>
        <RecordBlock title={t("DashboardIssuance.newDesign.details.operational")}>
          <dl>
            <RecordRow label={t("DashboardIssuance.newDesign.overview.signingWallet")}>
              {signingWallet?.label?.trim() || shortAddress(signingWallet?.publicKey) || notSet}
            </RecordRow>
            <RecordRow label={t("DashboardIssuance.newDesign.details.template")}>
              {getTokenTypeLabel(token.template, t)}
            </RecordRow>
            <RecordRow label={t("DashboardIssuance.newDesign.overview.accessControl")}>
              {accessControlLabel(ops.accessControlMode, t)}
            </RecordRow>
          </dl>
        </RecordBlock>
      </div>
      {editing ? (
        <TokenSaveFooter
          note={t("DashboardIssuance.newDesign.details.nothingSaved")}
          saving={saving}
          saveDisabled={
            !form.dirty ||
            Boolean(form.requiresMetadataSigner && ops.metadataSignerSelection.unavailableReason)
          }
          errorCount={showErrors ? form.errorCount : 0}
          onDiscard={() => {
            form.discard();
            setEditing(false);
          }}
          onSave={async () => {
            if (await form.save()) setEditing(false);
          }}
          signer={form.requiresMetadataSigner ? <MetadataSigner ops={ops} form={form} /> : null}
        />
      ) : null}
    </div>
  );
}

function MetadataSigner({ ops, form }: Pick<TokenTabProps, "ops" | "form">): ReactNode {
  const selection = ops.metadataSignerSelection;
  if (
    selection.wallets.length === 1 &&
    selection.wallets[0]?.id === form.metadataSignerWalletId &&
    !selection.unavailableReason
  ) {
    return null;
  }
  return (
    <TokenSignerSelect
      signerWallets={selection.wallets}
      signerWalletId={form.metadataSignerWalletId}
      signerUnavailableReason={selection.unavailableReason}
      onSignerWalletIdChange={form.setMetadataSignerWalletId}
    />
  );
}
