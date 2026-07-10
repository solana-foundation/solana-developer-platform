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
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { getAssetTypeLabel, getCategoryLabel } from "./asset-taxonomy";
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
  label: string;
  Icon: LucideIcon;
}[] = [
  { id: "token", label: "Token", Icon: FileText },
  { id: "explorer", label: "Explorer", Icon: Globe },
  { id: "wallet", label: "Wallet", Icon: Wallet },
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
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs text-secondary">
      <Icon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
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
  const [showOptional, setShowOptional] = useState(false);
  const [surface, setSurface] = useState<PreviewSurface>("token");
  const [jsonOpen, setJsonOpen] = useState(false);
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);
  const publicMetadata = buildPublicMetadata(draft);

  // Core identity + classification: inherent to the token / served from the
  // token record, so always public and not toggleable.
  const alwaysPublic: StaticField[] = [
    {
      key: "name",
      label: "Name",
      value: draft.name.trim() || "Untitled asset",
    },
    draft.symbol.trim() ? { key: "symbol", label: "Symbol", value: draft.symbol.trim() } : null,
    draft.description.trim()
      ? {
          key: "description",
          label: "Description",
          value: draft.description.trim(),
        }
      : null,
    { key: "decimals", label: "Decimals", value: draft.decimals.trim() || "—" },
    categoryLabel ? { key: "category", label: "Category", value: categoryLabel } : null,
    typeLabel ? { key: "type", label: "Asset type", value: typeLabel } : null,
    draft.imageUrl.trim() ? { key: "logo", label: "Logo", value: fileName(draft.imageUrl) } : null,
  ].filter((field): field is StaticField => Boolean(field));

  // Optional asset.* fields whose public/private state the issuer controls.
  const candidates = getPublicFieldCandidates(draft);
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
      ? [{ label: "Symbol", value: draft.symbol.trim(), path: "symbol" }]
      : []),
    {
      label: "Decimals",
      value: draft.decimals.trim() || "—",
      path: "decimals",
    },
    ...(categoryLabel ? [{ label: "Category", value: categoryLabel, path: "category" }] : []),
    ...(typeLabel ? [{ label: "Asset type", value: typeLabel, path: "type" }] : []),
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
          <h3 className="text-xl font-medium text-primary">Public token information</h3>
          <p className="mt-0.5 text-sm text-tertiary">
            This is how your asset will appear to wallets, explorers, and the public.
          </p>
        </div>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Checklist — public coverage + what's public, with interactive toggles. */}
        <div>
          <div className="mb-2 flex h-8 items-center justify-between gap-3">
            <p className="text-sm font-medium text-primary">Included in public view</p>
            <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs font-medium text-tertiary">
              {publicCount} public
            </span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border-default bg-white">
            {/* Coverage meter sits inside the card so its top edge aligns with the preview card. */}
            <div className="border-b border-border-subtle px-4 py-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${coveragePct}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-tertiary">
                {publicCount} of {totalCount} fields public
              </p>
            </div>
            <div className="divide-y divide-border-subtle">
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
            <div className="mt-3 overflow-hidden rounded-2xl border border-border-default bg-white">
              <button
                type="button"
                onClick={() => setShowOptional((value) => !value)}
                aria-expanded={showOptional}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle focus-visible:outline-none"
              >
                <div className="flex items-start gap-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-tertiary" />
                  <div>
                    <p className="text-sm font-medium text-primary">Not included by default</p>
                    <p className="text-sm text-tertiary">
                      These fields stay private unless you choose to include them.
                    </p>
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-tertiary transition-transform",
                    showOptional && "rotate-180"
                  )}
                />
              </button>
              {showOptional ? (
                <div className="divide-y divide-border-subtle border-t border-border-subtle">
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
            <p className="text-sm font-medium text-primary">Preview</p>
            <SurfaceSwitch value={surface} onChange={setSurface} />
          </div>
          <div className="rounded-2xl border border-border-default bg-white p-5">
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
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-fill-subtle p-0.5">
      {SURFACES.map(({ id, label, Icon }) => {
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
                ? "border-border-subtle bg-white text-primary"
                : "border-transparent text-tertiary hover:text-primary"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
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
  const dim = size === "sm" ? "h-10 w-10" : "h-14 w-14";
  const initial = symbol.slice(0, 1).toUpperCase() || "?";

  if (imageUrl.trim()) {
    return (
      <div className={cn("relative shrink-0", dim)}>
        <span className="absolute -inset-0.5 rounded-full bg-fill-subtle" aria-hidden />
        {/* biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here. */}
        <img
          src={imageUrl}
          alt={`${name || "Asset"} logo`}
          className={cn("relative rounded-full border border-border-default object-cover", dim)}
        />
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <span className="absolute -inset-0.5 rounded-full bg-fill-subtle" aria-hidden />
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border border-border-default bg-fill-subtle font-semibold text-primary",
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
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-lg leading-tight font-semibold tracking-tight text-primary">
          {draft.name.trim() || "Untitled asset"}
        </h4>
        {draft.symbol.trim() ? (
          <span className="rounded-full border border-border-default bg-fill-subtle px-2 py-0.5 text-xs font-medium text-secondary">
            {draft.symbol.trim()}
          </span>
        ) : null}
        <span className="ml-1 flex items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs font-medium text-tertiary">
          <CircleCheck className="h-3 w-3 text-tertiary" />
          Preview
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
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-fill-subtle px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-tertiary">Mint address</p>
        <p className="mt-0.5 truncate text-sm font-medium text-primary">
          {shortAddress(mintAddress)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <CopyIconButton value={mintAddress} label="Copy mint address" />
        {explorerHref ? (
          <Button asChild variant="ghost" size="icon-xs" aria-label="View on explorer">
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
  const { copy, copied } = useCopy(1200);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void copy(value);
        toast.success("Copied", { position: "bottom-right" });
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
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
  return (
    <div>
      <div className="flex items-start gap-4">
        <AssetAvatar imageUrl={draft.imageUrl} name={draft.name} symbol={draft.symbol} />
        <IdentityHeader draft={draft} categoryLabel={categoryLabel} typeLabel={typeLabel} />
      </div>

      <p
        className={cn(
          "mt-3 text-sm leading-relaxed",
          draft.description.trim() ? "text-secondary" : "text-muted"
        )}
      >
        {draft.description.trim() || "No public description"}
      </p>

      <dl className="mt-4 space-y-2 border-t border-border-subtle pt-4">
        {facts.map((fact) => {
          const Icon = iconFor(fact.path);
          return (
            <div key={fact.label} className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-tertiary [&_svg]:size-4">
                <Icon />
              </span>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
                <dt className="shrink-0 text-sm text-tertiary">{fact.label}</dt>
                <dd className="min-w-0 text-right text-sm font-medium text-primary">
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
        <div className="mt-4 border-t border-border-subtle pt-4">
          <AddressRow mintAddress={mintAddress} explorerHref={explorerHref} />
        </div>
      ) : null}
    </div>
  );
}

// Wallet surface — a compact token-list row: logo + name / classification on the
// left, symbol + decimals on the right.
function WalletPreview({ draft, categoryLabel, typeLabel }: PreviewProps) {
  const secondary = [draft.symbol.trim(), categoryLabel || typeLabel].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3">
      <AssetAvatar imageUrl={draft.imageUrl} name={draft.name} symbol={draft.symbol} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">
          {draft.name.trim() || "Untitled asset"}
        </p>
        <p className="mt-0.5 truncate text-xs text-tertiary">{secondary || "—"}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-medium text-primary">{draft.symbol.trim() || "—"}</p>
        <p className="mt-0.5 text-xs text-tertiary">{draft.decimals.trim() || "—"} decimals</p>
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
          mintAddress && "border-t border-border-subtle pt-4"
        )}
      >
        {facts.map((fact) => {
          const Icon = iconFor(fact.path);
          return (
            <span
              key={fact.label}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-fill-subtle px-2.5 py-1.5"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="text-xs text-tertiary">{fact.label}</span>
              <span className="max-w-[12rem] truncate text-xs font-medium text-primary">
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
  const hasToggle = Boolean(onToggle) && !locked;

  const body = (
    <>
      <RoundCheck checked={checked} interactive={hasToggle && !disabled} disabled={disabled} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary">{label}</p>
        {value ? <p className="mt-0.5 break-words text-sm text-tertiary">{value}</p> : null}
      </div>
      {locked ? (
        <span
          title="Always public — can't be hidden"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fill text-tertiary"
        >
          <Lock className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </>
  );

  if (!hasToggle) {
    return (
      <div className={cn("flex items-start gap-3 px-4 py-3", locked && "bg-fill-subtle")}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-disabled={disabled}
      aria-label={checked ? "Public — hide this field" : "Hidden — show this field publicly"}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-default"
          : "cursor-pointer hover:bg-fill-subtle focus-visible:bg-fill-subtle focus-visible:outline-none"
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
          ? "border-primary bg-primary text-white"
          : "border-border-strong bg-white text-transparent",
        interactive && !checked && "group-hover:border-primary group-hover:bg-fill",
        disabled && "opacity-60"
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}
