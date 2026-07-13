"use client";

import {
  Activity,
  Anchor,
  Banknote,
  Check,
  ChevronDown,
  CircleCheck,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Image,
  KeyRound,
  Layers,
  Lock,
  type LucideIcon,
  MapPin,
  ShieldCheck,
  Tag,
  Target,
  User,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { getAssetTypeLabel, getCategoryLabelKey } from "./asset-taxonomy";
import {
  buildPublicMetadata,
  getDefaultPublicFields,
  getPublicFieldCandidates,
  safeLinkHref,
} from "./draft-mapping";
import type { DraftState } from "./issuance-draft-wizard.types";
import { MetadataJsonPanel, MetadataJsonToggle } from "./metadata-json";

interface StaticField {
  key: string;
  label: string;
  value: string;
}

interface Fact {
  label: string;
  value: string;
  href?: string;
  path?: string;
}

// The three surfaces the public asset can appear on. The preview card renders a
// distinct mock per surface so the "wallets, explorers, and the public" copy is
// literal rather than aspirational.
type PreviewSurface = "wallet" | "explorer" | "token";

const SURFACES: readonly {
  id: PreviewSurface;
  Icon: LucideIcon;
}[] = [
  { id: "token", Icon: FileText },
  { id: "explorer", Icon: Globe },
  { id: "wallet", Icon: Wallet },
];

interface PreviewProps {
  draft: DraftState;
  facts: Fact[];
  categoryLabel: string | null;
  typeLabel: string | null;
  mintAddress?: string | null;
  explorerHref?: string | null;
}

// Human filename for a logo URL (falls back to the raw value).
function fileName(url: string): string {
  const trimmed = url.trim();
  const fromPath = (path: string) => path.split("/").filter(Boolean).pop() ?? "";
  try {
    return fromPath(new URL(trimmed).pathname) || trimmed;
  } catch {
    return fromPath(trimmed) || trimmed;
  }
}

// Short, non-mono rendering of an on-chain address (SDP rule: addresses are not
// monospace). Mirrors the truncation used in the asset profile header.
function shortAddress(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

// Every issuance field maps to its own icon so no two rows in a given preview
// share a glyph. Keys are a field path's final dot-segment, lowercased with
// non-letters stripped ("asset.reserveAsset" → "reserveasset"), so the shared
// "asset." prefix can't leak into the match — it previously made every path
// contain "asset" and collapse fields (offering/underlying/custodian) onto one
// icon, and lumped "reserve" in with "backing".
const FIELD_ICONS: Record<string, LucideIcon> = {
  name: Tag,
  symbol: Hash,
  decimals: Clock,
  category: Layers,
  type: FileText,
  logo: Image,
  image: Image,
  icon: Image,
  description: Activity,
  issuername: User,
  pegcurrency: Anchor,
  pegtarget: Target,
  backingtype: ShieldCheck,
  reserveasset: Banknote,
  reservecustodian: Wallet,
  custodian: Wallet,
  website: Globe,
  jurisdiction: MapPin,
  offeringtype: Tag,
  underlyingasset: Coins,
};

// Resilient fallbacks for keys not in the exact map (e.g. future fields),
// matched as ordered substring rules — first match wins, so the more specific
// keyword comes first ("custod" before "reserve" so a reserve custodian doesn't
// borrow the reserve-asset icon).
const ICON_RULES: readonly { keywords: readonly string[]; icon: LucideIcon }[] = [
  { keywords: ["website", "url"], icon: Globe },
  { keywords: ["mint", "address"], icon: KeyRound },
  { keywords: ["supply", "total"], icon: Coins },
  { keywords: ["custod"], icon: Wallet },
  { keywords: ["reserve"], icon: Banknote },
  { keywords: ["backing", "collateral"], icon: ShieldCheck },
  { keywords: ["issuer", "owner", "authority"], icon: User },
  { keywords: ["jurisdiction", "country", "location"], icon: MapPin },
  { keywords: ["currency", "fiat"], icon: Anchor },
  { keywords: ["peg", "target"], icon: Target },
];

// Map a fact path (or label) to its icon. The lookup key is the field's final
// path segment, so "asset.reserveAsset" and a bare "reserveAsset" resolve the
// same. Exact field matches win; otherwise fall back to the substring rules,
// then a generic check.
function iconFor(labelOrPath?: string): LucideIcon {
  if (!labelOrPath) return CircleCheck;
  const key = (labelOrPath.split(".").pop() ?? labelOrPath).toLowerCase().replace(/[^a-z]/g, "");
  return (
    FIELD_ICONS[key] ??
    ICON_RULES.find((r) => r.keywords.some((k) => key.includes(k)))?.icon ??
    CircleCheck
  );
}

// Small inline classification chip used in the identity header.
function ClassificationChip({ label, path }: { label: string; path: string }) {
  const Icon = iconFor(path);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-2 py-0.5 text-xs text-[rgba(28,28,29,0.7)]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[rgba(28,28,29,0.5)]" />
      <span className="truncate">{label}</span>
    </span>
  );
}

// The public-vs-private projection shared by the creation wizard (Step 3) and
// the asset management workspace (Public information tab). A live preview of the
// public asset card — switchable between wallet, explorer, and token-page
// surfaces — sits beside an interactive checklist with a public-coverage meter:
// core identity fields are always public (locked), optional asset.* fields can
// be toggled, and non-default optional fields live under a collapse. When
// `onToggleField` is omitted the checklist renders read-only. `mintAddress` /
// `explorerHref` are only present once a token is deployed (the asset-profile
// tab); the create wizard leaves them undefined and the address UI degrades to a
// placeholder.
export function PublicInfoPreview({
  draft,
  onToggleField,
  disabled,
  mintAddress,
  explorerHref,
}: {
  draft: DraftState;
  onToggleField?: (path: string, enabled: boolean) => void;
  disabled?: boolean;
  mintAddress?: string | null;
  explorerHref?: string | null;
}) {
  const t = useTranslations();
  const [showOptional, setShowOptional] = useState(false);
  const [surface, setSurface] = useState<PreviewSurface>("token");
  const [jsonOpen, setJsonOpen] = useState(false);
  const categoryLabelKey = getCategoryLabelKey(draft.assetCategory);
  const categoryLabel = categoryLabelKey ? t(categoryLabelKey) : null;
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType, t);
  const publicMetadata = buildPublicMetadata(draft);

  // Core identity + classification: inherent to the token / served from the
  // token record, so always public and not toggleable.
  const alwaysPublic: StaticField[] = [
    {
      key: "name",
      label: t("DashboardIssuance.publicInfo.name"),
      value: draft.name.trim() || t("DashboardIssuance.publicInfo.untitledAsset"),
    },
    draft.symbol.trim()
      ? {
          key: "symbol",
          label: t("DashboardIssuance.publicInfo.symbol"),
          value: draft.symbol.trim(),
        }
      : null,
    draft.description.trim()
      ? {
          key: "description",
          label: t("DashboardIssuance.publicInfo.description"),
          value: draft.description.trim(),
        }
      : null,
    {
      key: "decimals",
      label: t("DashboardIssuance.publicInfo.decimals"),
      value: draft.decimals.trim() || t("DashboardIssuance.publicInfo.notProvided"),
    },
    categoryLabel
      ? { key: "category", label: t("DashboardIssuance.publicInfo.category"), value: categoryLabel }
      : null,
    typeLabel
      ? { key: "type", label: t("DashboardIssuance.publicInfo.assetType"), value: typeLabel }
      : null,
    draft.imageUrl.trim()
      ? {
          key: "logo",
          label: t("DashboardIssuance.publicInfo.logo"),
          value: fileName(draft.imageUrl),
        }
      : null,
  ].filter((field): field is StaticField => Boolean(field));

  // Optional asset.* fields whose public/private state the issuer controls.
  const candidates = getPublicFieldCandidates(draft, t);
  const enabledCandidates = candidates.filter((candidate) => candidate.enabled);
  const defaultPaths = new Set(
    draft.assetCategory && draft.assetType
      ? getDefaultPublicFields(draft.assetCategory, draft.assetType)
      : []
  );
  const defaultInteractive = candidates.filter((candidate) => defaultPaths.has(candidate.path));
  const optionalInteractive = candidates.filter((candidate) => !defaultPaths.has(candidate.path));

  // Public-coverage summary: locked identity fields are always public; optional
  // candidates count only when enabled.
  const publicCount = alwaysPublic.length + enabledCandidates.length;
  const totalCount = alwaysPublic.length + candidates.length;
  const coveragePct = totalCount > 0 ? Math.round((publicCount / totalCount) * 100) : 0;

  // Preview facts: fixed identity facts plus every currently-public optional
  // field, so hiding a field also removes it from the preview.
  const facts: Fact[] = [
    ...(draft.symbol.trim()
      ? [
          {
            label: t("DashboardIssuance.publicInfo.symbol"),
            value: draft.symbol.trim(),
            path: "symbol",
          },
        ]
      : []),
    {
      label: t("DashboardIssuance.publicInfo.decimals"),
      value: draft.decimals.trim() || t("DashboardIssuance.publicInfo.notProvided"),
      path: "decimals",
    },
    ...(categoryLabel
      ? [
          {
            label: t("DashboardIssuance.publicInfo.category"),
            value: categoryLabel,
            path: "category",
          },
        ]
      : []),
    ...(typeLabel
      ? [{ label: t("DashboardIssuance.publicInfo.assetType"), value: typeLabel, path: "type" }]
      : []),
    ...enabledCandidates.map((candidate) => ({
      label: candidate.label,
      value: candidate.value,
      href: candidate.path === "asset.website" ? safeLinkHref(candidate.value) : undefined,
      path: candidate.path,
    })),
  ];

  const previewProps: PreviewProps = {
    draft,
    facts,
    categoryLabel,
    typeLabel,
    mintAddress,
    explorerHref,
  };

  const toggle = onToggleField
    ? (path: string, next: boolean) => onToggleField(path, next)
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-medium text-[#1c1c1d]">
            {t("DashboardIssuance.publicInfo.publicTokenInformation")}
          </h3>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
            {t("DashboardIssuance.publicInfo.publicTokenInfoHelp")}
          </p>
        </div>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Checklist — public coverage + what's public, with interactive toggles. */}
        <div>
          <div className="mb-2 flex h-8 items-center justify-between gap-3">
            <p className="text-sm font-medium text-[#1c1c1d]">
              {t("DashboardIssuance.publicInfo.includedInPublicView")}
            </p>
            <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.6)]">
              {t("DashboardIssuance.publicInfo.publicCount", { count: publicCount })}
            </span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white">
            {/* Coverage meter sits inside the card so its top edge aligns with the preview card. */}
            <div className="border-b border-[rgba(28,28,29,0.08)] px-4 py-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgba(28,28,29,0.08)]">
                <div
                  className="h-full rounded-full bg-[#0f0f10] transition-[width]"
                  style={{ width: `${coveragePct}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-[rgba(28,28,29,0.5)]">
                {t("DashboardIssuance.publicInfo.publicCoverage", { publicCount, totalCount })}
              </p>
            </div>
            <div className="divide-y divide-[rgba(28,28,29,0.06)]">
              {alwaysPublic.map((field) => (
                <FieldRow key={field.key} label={field.label} value={field.value} checked locked />
              ))}
              {defaultInteractive.map((candidate) => (
                <FieldRow
                  key={candidate.path}
                  label={candidate.label}
                  value={candidate.value}
                  checked={candidate.enabled}
                  disabled={disabled}
                  onToggle={toggle ? () => toggle(candidate.path, !candidate.enabled) : undefined}
                />
              ))}
            </div>
          </div>

          {optionalInteractive.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white">
              <button
                type="button"
                onClick={() => setShowOptional((value) => !value)}
                aria-expanded={showOptional}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[rgba(28,28,29,0.03)] focus-visible:bg-[rgba(28,28,29,0.04)] focus-visible:outline-none"
              >
                <div className="flex items-start gap-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
                  <div>
                    <p className="text-sm font-medium text-[#1c1c1d]">
                      {t("DashboardIssuance.publicInfo.notIncludedByDefault")}
                    </p>
                    <p className="text-sm text-[rgba(28,28,29,0.55)]">
                      {t("DashboardIssuance.publicInfo.notIncludedHelp")}
                    </p>
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)] transition-transform",
                    showOptional && "rotate-180"
                  )}
                />
              </button>
              {showOptional ? (
                <div className="divide-y divide-[rgba(28,28,29,0.06)] border-t border-[rgba(28,28,29,0.08)]">
                  {optionalInteractive.map((candidate) => (
                    <FieldRow
                      key={candidate.path}
                      label={candidate.label}
                      value={candidate.value}
                      checked={candidate.enabled}
                      disabled={disabled}
                      onToggle={
                        toggle ? () => toggle(candidate.path, !candidate.enabled) : undefined
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Preview — how the asset appears publicly, across surfaces. The JSON
            viewer sits under this column when toggled open. */}
        <div>
          <div className="mb-2 flex h-8 items-center justify-between gap-3">
            <p className="text-sm font-medium text-[#1c1c1d]">
              {t("DashboardIssuance.publicInfo.preview")}
            </p>
            <SurfaceSwitch value={surface} onChange={setSurface} />
          </div>
          <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
            {surface === "wallet" ? <WalletPreview {...previewProps} /> : null}
            {surface === "explorer" ? <ExplorerPreview {...previewProps} /> : null}
            {surface === "token" ? <TokenPreview {...previewProps} /> : null}
          </div>

          {jsonOpen ? (
            <div className="mt-3">
              <MetadataJsonPanel metadata={publicMetadata} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Segmented control switching the preview between wallet / explorer / token
// surfaces. Hand-rolled to keep the flat SDP grammar (tinted track, white active
// pill, no shadow); the active pill's border is mirrored by a transparent border
// on inactive items so nothing shifts on selection.
function SurfaceSwitch({
  value,
  onChange,
}: {
  value: PreviewSurface;
  onChange: (next: PreviewSurface) => void;
}) {
  const t = useTranslations();
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] p-0.5">
      {SURFACES.map(({ id, Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "border-[rgba(28,28,29,0.08)] bg-white text-[#1c1c1d]"
                : "border-transparent text-[rgba(28,28,29,0.55)] hover:text-[#1c1c1d]"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(`DashboardIssuance.publicInfo.${id}`)}
          </button>
        );
      })}
    </div>
  );
}

// Token logo with a subtle inset halo and a symbol-initial fallback. `size`
// scales for the compact wallet row vs. the fuller token/explorer headers.
function AssetAvatar({
  imageUrl,
  name,
  symbol,
  size = "md",
}: {
  imageUrl: string;
  name: string;
  symbol: string;
  size?: "sm" | "md";
}) {
  const t = useTranslations();
  const dim = size === "sm" ? "h-10 w-10" : "h-14 w-14";
  const initial = symbol.slice(0, 1).toUpperCase() || "?";

  if (imageUrl.trim()) {
    return (
      <div className={cn("relative shrink-0", dim)}>
        <span className="absolute -inset-0.5 rounded-full bg-[rgba(28,28,29,0.02)]" aria-hidden />
        {/* biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here. */}
        <img
          src={imageUrl}
          alt={t("DashboardIssuance.publicInfo.assetLogo", {
            name: name || t("DashboardIssuance.publicInfo.asset"),
          })}
          className={cn(
            "relative rounded-full border border-[rgba(28,28,29,0.1)] object-cover",
            dim
          )}
        />
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <span className="absolute -inset-0.5 rounded-full bg-[rgba(28,28,29,0.02)]" aria-hidden />
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] font-semibold text-[#1c1c1d]",
          dim,
          size === "sm" ? "text-base" : "text-xl"
        )}
      >
        {initial}
      </div>
    </div>
  );
}

// Name + symbol pill + non-assertive "Preview" badge, then classification chips.
// Shared by the token and explorer surfaces.
function IdentityHeader({
  draft,
  categoryLabel,
  typeLabel,
}: Pick<PreviewProps, "draft" | "categoryLabel" | "typeLabel">) {
  const t = useTranslations();
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-lg leading-tight font-semibold tracking-tight text-[#1c1c1d]">
          {draft.name.trim() || t("DashboardIssuance.publicInfo.untitledAsset")}
        </h4>
        {draft.symbol.trim() ? (
          <span className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.7)]">
            {draft.symbol.trim()}
          </span>
        ) : null}
        <span className="ml-1 flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.6)]">
          <CircleCheck className="h-3 w-3 text-[rgba(28,28,29,0.5)]" />
          {t("DashboardIssuance.publicInfo.preview")}
        </span>
      </div>

      {categoryLabel || typeLabel ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {categoryLabel ? <ClassificationChip label={categoryLabel} path="category" /> : null}
          {typeLabel ? <ClassificationChip label={typeLabel} path="type" /> : null}
        </div>
      ) : null}
    </div>
  );
}

// A tinted row exposing the on-chain mint address with copy + explorer actions.
// Only rendered once the token is deployed and a mint address exists.
function AddressRow({
  mintAddress,
  explorerHref,
}: {
  mintAddress: string;
  explorerHref?: string | null;
}) {
  const t = useTranslations();
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-[rgba(28,28,29,0.5)]">
          {t("DashboardIssuance.publicInfo.mintAddress")}
        </p>
        <p className="mt-0.5 truncate text-sm font-medium text-[#1c1c1d]">
          {shortAddress(mintAddress)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <CopyIconButton
          value={mintAddress}
          label={t("DashboardIssuance.publicInfo.copyMintAddress")}
        />
        {explorerHref ? (
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            aria-label={t("DashboardIssuance.publicInfo.viewOnExplorer")}
          >
            <a href={explorerHref} target="_blank" rel="noreferrer">
              <ExternalLink />
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// Copy affordance mirroring the payments CopyButton pattern.
function CopyIconButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations();
  const { copy, copied } = useCopy(1200);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void copy(value);
        toast.success(t("DashboardIssuance.publicInfo.copied"), { position: "bottom-right" });
      }}
    >
      {copied ? <Check className="text-status-success-text" /> : <Copy />}
    </Button>
  );
}

// Token-page surface — the fullest view: identity header, description, an
// icon-chip fact list, and (once deployed) a mint-address footer.
function TokenPreview({
  draft,
  facts,
  categoryLabel,
  typeLabel,
  mintAddress,
  explorerHref,
}: PreviewProps) {
  const t = useTranslations();
  return (
    <div>
      <div className="flex items-start gap-4">
        <AssetAvatar imageUrl={draft.imageUrl} name={draft.name} symbol={draft.symbol} />
        <IdentityHeader draft={draft} categoryLabel={categoryLabel} typeLabel={typeLabel} />
      </div>

      <p
        className={cn(
          "mt-3 text-sm leading-relaxed",
          draft.description.trim() ? "text-[rgba(28,28,29,0.62)]" : "text-[rgba(28,28,29,0.4)]"
        )}
      >
        {draft.description.trim() || t("DashboardIssuance.publicInfo.noPublicDescription")}
      </p>

      <dl className="mt-4 space-y-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
        {facts.map((fact) => {
          const Icon = iconFor(fact.path);
          return (
            <div key={fact.label} className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.5)] [&_svg]:size-4">
                <Icon />
              </span>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
                <dt className="shrink-0 text-sm text-[rgba(28,28,29,0.55)]">{fact.label}</dt>
                <dd className="min-w-0 text-right text-sm font-medium text-[#1c1c1d]">
                  {fact.href ? (
                    <a
                      href={fact.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex max-w-[200px] items-center gap-1 truncate hover:underline"
                    >
                      <span className="truncate">{fact.value}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="block truncate">{fact.value}</span>
                  )}
                </dd>
              </div>
            </div>
          );
        })}
      </dl>

      {mintAddress ? (
        <div className="mt-4 border-t border-[rgba(28,28,29,0.08)] pt-4">
          <AddressRow mintAddress={mintAddress} explorerHref={explorerHref} />
        </div>
      ) : null}
    </div>
  );
}

// Wallet surface — a compact token-list row: logo + name / classification on the
// left, symbol + decimals on the right.
function WalletPreview({ draft, categoryLabel, typeLabel }: PreviewProps) {
  const t = useTranslations();
  const secondary = [draft.symbol.trim(), categoryLabel || typeLabel].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3">
      <AssetAvatar imageUrl={draft.imageUrl} name={draft.name} symbol={draft.symbol} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[#1c1c1d]">
          {draft.name.trim() || t("DashboardIssuance.publicInfo.untitledAsset")}
        </p>
        <p className="mt-0.5 truncate text-xs text-[rgba(28,28,29,0.5)]">
          {secondary || t("DashboardIssuance.publicInfo.notProvided")}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-medium text-[#1c1c1d]">
          {draft.symbol.trim() || t("DashboardIssuance.publicInfo.notProvided")}
        </p>
        <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.5)]">
          {t("DashboardIssuance.publicInfo.decimalsValue", {
            count: draft.decimals.trim() || t("DashboardIssuance.publicInfo.notProvided"),
          })}
        </p>
      </div>
    </div>
  );
}

// Explorer surface — identity header, a prominent mint-address row, then a
// wrapped strip of metadata pills (label + value), the way an explorer lists
// token metadata.
function ExplorerPreview({
  draft,
  facts,
  categoryLabel,
  typeLabel,
  mintAddress,
  explorerHref,
}: PreviewProps) {
  return (
    <div>
      <div className="flex items-start gap-4">
        <AssetAvatar imageUrl={draft.imageUrl} name={draft.name} symbol={draft.symbol} />
        <IdentityHeader draft={draft} categoryLabel={categoryLabel} typeLabel={typeLabel} />
      </div>

      {mintAddress ? (
        <div className="mt-4">
          <AddressRow mintAddress={mintAddress} explorerHref={explorerHref} />
        </div>
      ) : null}

      <div
        className={cn(
          "mt-4 flex flex-wrap gap-2",
          mintAddress && "border-t border-[rgba(28,28,29,0.08)] pt-4"
        )}
      >
        {facts.map((fact) => {
          const Icon = iconFor(fact.path);
          return (
            <span
              key={fact.label}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-2.5 py-1.5"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-[rgba(28,28,29,0.45)]" />
              <span className="text-xs text-[rgba(28,28,29,0.55)]">{fact.label}</span>
              <span className="max-w-[12rem] truncate text-xs font-medium text-[#1c1c1d]">
                {fact.value}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// A single checklist row. When it has a toggle (and isn't locked) the *entire*
// row is the click target — pointer cursor, full-width hover tint — not just the
// round check. Locked identity rows and read-only renders stay static divs.
function FieldRow({
  label,
  value,
  checked,
  onToggle,
  locked,
  disabled,
}: {
  label: string;
  value: string;
  checked: boolean;
  onToggle?: () => void;
  locked?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const hasToggle = Boolean(onToggle) && !locked;

  const body = (
    <>
      <RoundCheck checked={checked} interactive={hasToggle && !disabled} disabled={disabled} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#1c1c1d]">{label}</p>
        {value ? (
          <p className="mt-0.5 wrap-anywhere text-sm text-[rgba(28,28,29,0.55)]">{value}</p>
        ) : null}
      </div>
      {locked ? (
        <span
          title={t("DashboardIssuance.publicInfo.alwaysPublic")}
          className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-full bg-[rgba(28,28,29,0.08)] text-[rgba(28,28,29,0.55)]"
        >
          <Lock className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </>
  );

  if (!hasToggle) {
    return (
      <div
        className={cn("flex items-start gap-3 px-4 py-3", locked && "bg-[rgba(28,28,29,0.025)]")}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-disabled={disabled}
      aria-label={t(
        checked
          ? "DashboardIssuance.publicInfo.hidePublicField"
          : "DashboardIssuance.publicInfo.showPublicField"
      )}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-default"
          : "cursor-pointer hover:bg-[rgba(28,28,29,0.03)] focus-visible:bg-[rgba(28,28,29,0.04)] focus-visible:outline-none"
      )}
    >
      {body}
    </button>
  );
}

// Purely presentational round checkbox; the click is handled by the parent
// FieldRow so the whole row is interactive. `interactive` adds the hover
// affordance (mirrored off the row via group-hover).
function RoundCheck({
  checked,
  interactive,
  disabled,
}: {
  checked: boolean;
  interactive?: boolean;
  disabled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        checked
          ? "border-[#0f0f10] bg-[#0f0f10] text-white"
          : "border-[rgba(28,28,29,0.28)] bg-white text-transparent",
        interactive &&
          !checked &&
          "group-hover:border-[#0f0f10] group-hover:bg-[rgba(28,28,29,0.06)]",
        disabled && "opacity-60"
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}
