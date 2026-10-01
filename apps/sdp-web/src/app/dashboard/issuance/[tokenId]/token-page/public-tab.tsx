"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { RecordBlock, RecordRow } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { IssuanceCheckRow, LockHint } from "../../issuance-checkbox.redesign";
import { IssuedTokenMark } from "../../issued-token-mark.redesign";
import { shortAddress, type TokenTabProps } from "./token-page.shared";
import { TokenSaveFooter } from "./token-save-footer";

type Preview = "token" | "explorer" | "wallet";

interface PublicField {
  id: string;
  label: MessageKey;
  /** The metadata path a toggle publishes; none for a field the toggle cannot move. */
  path?: string;
  /** Always published by the token metadata URI, whatever is chosen here. */
  core?: boolean;
  /** Kept in SDP: it has no public path. */
  private?: boolean;
  why?: MessageKey;
}

// What `GET /v1/issuance/tokens/{id}/metadata.json` serves: the token's own name, symbol,
// description and image always, then the asset.* and chain.decimals paths chosen here.
const FIELDS: PublicField[] = [
  {
    id: "name",
    label: "DashboardIssuance.newDesign.publicInfo.name",
    core: true,
    why: "DashboardIssuance.newDesign.publicInfo.nameWhy",
  },
  {
    id: "symbol",
    label: "DashboardIssuance.newDesign.publicInfo.symbol",
    core: true,
    why: "DashboardIssuance.newDesign.publicInfo.symbolWhy",
  },
  {
    id: "description",
    label: "DashboardIssuance.newDesign.publicInfo.description",
    core: true,
    why: "DashboardIssuance.newDesign.publicInfo.descriptionWhy",
  },
  {
    id: "decimals",
    label: "DashboardIssuance.newDesign.publicInfo.decimals",
    path: "chain.decimals",
  },
  { id: "website", label: "DashboardIssuance.newDesign.publicInfo.website", path: "asset.website" },
  {
    id: "issuer",
    label: "DashboardIssuance.newDesign.publicInfo.issuer",
    path: "asset.issuerName",
  },
  {
    id: "currency",
    label: "DashboardIssuance.newDesign.publicInfo.currency",
    path: "asset.pegCurrency",
  },
  {
    id: "wallet",
    label: "DashboardIssuance.newDesign.publicInfo.signingWallet",
    private: true,
    why: "DashboardIssuance.newDesign.publicInfo.walletWhy",
  },
];

type TokenView = TokenTabProps["token"];
type ProfileDraft = TokenTabProps["form"]["draft"];

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = next && typeof next === "object" ? next : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] ?? path] = value;
}

/** Whether the metadata carries a field: core ones always, private ones never, the rest as chosen. */
function isFieldPublic(field: PublicField, selected: ReadonlySet<string>): boolean {
  if (field.core) return true;
  if (field.private) return false;
  return selected.has(field.path ?? "");
}

/** The value each field shows beside its toggle, keyed by field id. */
function publicFieldValues(
  token: TokenView,
  draft: ProfileDraft,
  signingWallet: TokenTabProps["ops"]["authorityWallets"][number] | undefined
): Record<string, string> {
  return {
    name: token.name,
    symbol: token.symbol,
    description: token.description ?? "",
    decimals: String(token.decimals),
    website: draft.website.trim(),
    issuer: draft.issuerName.trim(),
    currency: draft.pegCurrency,
    wallet: signingWallet?.label?.trim() || shortAddress(signingWallet?.publicKey),
  };
}

/** The metadata document the token's URI serves for the fields chosen in the draft. */
function projectPublicMetadata(draft: ProfileDraft, token: TokenView): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const source: Record<string, string> = {
    "asset.name": draft.name.trim(),
    "asset.description": draft.description.trim(),
    "asset.website": draft.website.trim(),
    "asset.issuerName": draft.issuerName.trim(),
    "asset.pegCurrency": draft.pegCurrency,
  };
  for (const path of draft.publicFields) {
    if (path === "chain.decimals") setPath(projected, path, token.decimals);
    else if (path.startsWith("asset.") && source[path]) setPath(projected, path, source[path]);
  }
  return {
    ...projected,
    name: token.name,
    symbol: token.symbol,
    ...(token.description ? { description: token.description } : {}),
    ...(token.imageUrl ? { image: token.imageUrl } : {}),
  };
}

/**
 * What the world can read about the token: the fields its public metadata carries, chosen
 * here, beside a preview of the metadata, an explorer and a wallet.
 */
export function TokenPublicTab({ token, ops, form }: TokenTabProps) {
  const t = useTranslations();
  const canEdit = useDashboardWorkspace().dashboardAccess.capabilities.canManageTokenWrite;
  const { draft, updateDraft, saving } = form;
  const selected = new Set(draft.publicFields);
  const signingWallet = ops.authorityWallets.find(
    (wallet) => wallet.id === (token.signingCustodyWalletId ?? draft.signingWalletId)
  );
  const values = publicFieldValues(token, draft, signingWallet);
  const isPublic = (field: PublicField) => isFieldPublic(field, selected);

  const metadata = useMemo(() => projectPublicMetadata(draft, token), [draft, token]);

  const toggle = (field: PublicField, on: boolean) => {
    if (!field.path) return;
    const next = new Set(draft.publicFields);
    if (on) next.add(field.path);
    else next.delete(field.path);
    updateDraft({ publicFields: [...next] });
  };

  return (
    <div className="flex flex-col">
      <div className="grid gap-12 @3xl:grid-cols-2">
        <PublicFieldsBlock
          values={values}
          isPublic={isPublic}
          canEdit={canEdit}
          saving={saving}
          onToggle={toggle}
        />
        <PublicPreviewBlock
          token={token}
          metadata={metadata}
          values={values}
          isPublic={isPublic}
          showsIssuer={selected.has("asset.issuerName")}
        />
      </div>
      {form.dirty ? (
        <TokenSaveFooter
          note={t("DashboardIssuance.newDesign.publicInfo.nothingPublished")}
          saving={saving}
          saveDisabled={false}
          errorCount={form.showErrors ? form.errorCount : 0}
          onDiscard={form.discard}
          onSave={() => void form.save()}
        />
      ) : null}
    </div>
  );
}

/** The fields the metadata can carry, each with a toggle, over a meter of how many it does. */
function PublicFieldsBlock({
  values,
  isPublic,
  canEdit,
  saving,
  onToggle,
}: {
  values: Record<string, string>;
  isPublic: (field: PublicField) => boolean;
  canEdit: boolean;
  saving: boolean;
  onToggle: (field: PublicField, on: boolean) => void;
}) {
  const t = useTranslations();
  const publicCount = FIELDS.filter(isPublic).length;
  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.publicInfo.included")}>
      <p className="text-body text-secondary">
        {t("DashboardIssuance.newDesign.publicInfo.count", {
          count: publicCount,
          total: FIELDS.length,
        })}
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-fill">
        <i
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.round((publicCount / FIELDS.length) * 100)}%` }}
        />
      </div>
      <div className="flex flex-col">
        {FIELDS.map((field) => {
          const locked = field.core || field.private || !canEdit;
          return (
            <IssuanceCheckRow
              key={field.id}
              checked={isPublic(field)}
              disabled={locked || saving}
              onChange={(on) => onToggle(field, on)}
              className="items-center py-2.5"
              aside={
                <>
                  <span className="max-w-56 truncate text-meta text-secondary">
                    {values[field.id] || t("DashboardIssuance.newDesign.notSet")}
                  </span>
                  {field.why ? <LockHint text={t(field.why)} /> : null}
                </>
              }
            >
              <span className="text-body text-primary">{t(field.label)}</span>
            </IssuanceCheckRow>
          );
        })}
      </div>
    </RecordBlock>
  );
}

/** The token as the metadata, an explorer or a wallet shows it, one at a time. */
function PublicPreviewBlock({
  token,
  metadata,
  values,
  isPublic,
  showsIssuer,
}: {
  token: TokenView;
  metadata: Record<string, unknown>;
  values: Record<string, string>;
  isPublic: (field: PublicField) => boolean;
  showsIssuer: boolean;
}) {
  const t = useTranslations();
  const [preview, setPreview] = useState<Preview>("token");
  return (
    <RecordBlock
      title={t("DashboardIssuance.newDesign.publicInfo.preview")}
      aside={
        <SegmentedControl
          ariaLabel={t("DashboardIssuance.newDesign.publicInfo.previewAs")}
          value={preview}
          onChange={(value) => setPreview(value as Preview)}
          options={[
            { value: "token", label: t("DashboardIssuance.newDesign.publicInfo.previewToken") },
            {
              value: "explorer",
              label: t("DashboardIssuance.newDesign.publicInfo.previewExplorer"),
            },
            {
              value: "wallet",
              label: t("DashboardIssuance.newDesign.publicInfo.previewWallet"),
            },
          ]}
        />
      }
    >
      {preview === "token" ? (
        <MetadataPreview metadata={metadata} />
      ) : preview === "explorer" ? (
        <ExplorerPreview token={token} values={values} isPublic={isPublic} />
      ) : (
        <WalletPreview token={token} issuer={showsIssuer ? values.issuer : undefined} />
      )}
    </RecordBlock>
  );
}

/** The token as an explorer lists it: its mint and the public fields that hold a value. */
function ExplorerPreview({
  token,
  values,
  isPublic,
}: {
  token: TokenView;
  values: Record<string, string>;
  isPublic: (field: PublicField) => boolean;
}) {
  const t = useTranslations();
  return (
    <>
      <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-4">
        <div className="flex items-center gap-3">
          <IssuedTokenMark symbol={token.symbol} logoUrl={token.imageUrl} size="md" />
          <span className="flex min-w-0 flex-col">
            <span className="text-body font-medium text-primary">{token.name}</span>
            <span className="text-meta text-secondary">{token.symbol}</span>
          </span>
        </div>
        <dl>
          <RecordRow label={t("DashboardIssuance.newDesign.publicInfo.mint")}>
            {token.mintAddress
              ? shortAddress(token.mintAddress)
              : t("DashboardIssuance.newDesign.publicInfo.notDeployed")}
          </RecordRow>
          {FIELDS.filter((field) => !field.private && field.id !== "name" && field.id !== "symbol")
            .filter(isPublic)
            .filter((field) => values[field.id])
            .map((field) => (
              <RecordRow key={field.id} label={t(field.label)}>
                <span className="truncate">{values[field.id]}</span>
              </RecordRow>
            ))}
        </dl>
      </div>
      <p className="text-meta text-secondary">
        {t("DashboardIssuance.newDesign.publicInfo.explorerNote")}
      </p>
    </>
  );
}

/** The token as a wallet lists it: its supply, and its issuer when that is published. */
function WalletPreview({ token, issuer }: { token: TokenView; issuer: string | undefined }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <>
      <div className="flex items-center gap-3 rounded-card border border-border-subtle p-4">
        <IssuedTokenMark symbol={token.symbol} logoUrl={token.imageUrl} size="md" />
        <span className="flex min-w-0 flex-col">
          <span className="text-body font-medium text-primary">{token.name}</span>
          <span className="text-meta text-secondary tabular-nums">
            {formatDecimalAmount(token.totalSupply || "0", locale)} {token.symbol}
          </span>
        </span>
      </div>
      {issuer ? (
        <p className="text-meta text-secondary">
          {t("DashboardIssuance.newDesign.publicInfo.issuedBy", { issuer })}
        </p>
      ) : null}
      <p className="text-meta text-secondary">
        {t("DashboardIssuance.newDesign.publicInfo.walletNote")}
      </p>
    </>
  );
}

function MetadataPreview({ metadata }: { metadata: Record<string, unknown> }) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1200);
  const json = JSON.stringify(metadata, null, 2);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta text-secondary">
          {t("DashboardIssuance.newDesign.publicInfo.tokenMetadata")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="-me-2.5"
          iconLeft={copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          onClick={() => void copy(json)}
        >
          {copied
            ? t("Shared.SharedComponents.copied")
            : t("DashboardIssuance.newDesign.publicInfo.copy")}
        </Button>
      </div>
      <pre className="overflow-x-auto font-mono text-meta leading-5 whitespace-pre-wrap break-words text-primary">
        {json}
      </pre>
    </div>
  );
}
