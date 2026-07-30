"use client";

import type { AssetProfile, Token } from "@sdp/types";
import {
  ArrowUpRight,
  Copy,
  DollarSign,
  Fingerprint,
  Globe,
  Hash,
  type LucideIcon,
  Play,
  Rocket,
  Terminal,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../create/asset-taxonomy";
import { SegmentedControl } from "../../create/segmented-control";
import { shortenAddress } from "../../wallet-identity";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import { buildIssuancePlaygroundHref } from "./playground-links";

// TEMP: header variant preview switcher — remove after a variant is chosen.
// A = hero card, B = split rail, C = banner card with tinted footer bar,
// D = three-column centered, E = framed logo with stacked actions,
// F = centered with wavy decoration, G = bleeding logo with metadata cells.
type HeaderVariant = "A" | "B" | "C" | "D" | "E" | "F" | "G";
const HEADER_VARIANTS = ["A", "B", "C", "D", "E", "F", "G"] as const;
const HEADER_VARIANT_STORAGE_KEY = "sdp.issuance.headerVariantPreview";

interface AssetProfileHeaderProps {
  token: Token;
  assetProfile: AssetProfile;
  explorerHref: string | null;
  canDeployToken: boolean;
  canManageTokenAdmin: boolean;
  isPending: boolean;
  deployDisabledReason?: string | null;
  pauseDisabledReason?: string | null;
  onCopyAddress: () => void;
  onCopyTokenId: () => void;
  onDeploy: () => void;
  onUnpause: () => void;
}

// TEMP: header variant preview switcher — remove after a variant is chosen.
export const HEADER_LAYOUTS: Record<
  HeaderVariant,
  (props: AssetProfileHeaderProps) => React.ReactElement
> = {
  A: HeaderVariantA,
  B: HeaderVariantB,
  C: HeaderVariantC,
  D: HeaderVariantD,
  E: HeaderVariantE,
  F: HeaderVariantF,
  G: HeaderVariantG,
};

// SDP design-system badge tokens (sdp-design-system.css): .badge-gray,
// .badge-green, .badge-amber, .badge-red — tinted fill + semantic text, no border.
// Decorated header in the asset-profile design language: logo avatar,
// classification chips with taxonomy icons, labeled identity fields.
export function AssetProfileHeader(props: AssetProfileHeaderProps) {
  const t = useTranslations();
  // TEMP: header variant preview switcher — remove after a variant is chosen.
  // SSR and first client paint always render "A"; the stored choice applies
  // after hydration (renderToStaticMarkup in unit tests never runs effects).
  const [variant, setVariant] = useState<HeaderVariant>("A");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(HEADER_VARIANT_STORAGE_KEY);
      if (stored && (HEADER_VARIANTS as readonly string[]).includes(stored)) {
        setVariant(stored as HeaderVariant);
      }
    } catch {
      // Storage unavailable — stay on the default variant.
    }
  }, []);
  const selectVariant = (next: string) => {
    setVariant(next as HeaderVariant);
    try {
      window.localStorage.setItem(HEADER_VARIANT_STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the selection just won't persist.
    }
  };
  const Layout = HEADER_LAYOUTS[variant];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <SegmentedControl
          options={HEADER_VARIANTS.map((value) => ({ value, label: value }))}
          value={variant}
          onChange={selectVariant}
          ariaLabel={t("DashboardIssuance.header.variantPreview")}
          optionClassName="px-2.5 py-1"
        />
      </div>
      <Layout {...props} />
    </div>
  );
}

// Variant A — hero card: the whole header inside the canonical v2 card, with
// labeled identifier fields below a divider (asset-overview-hero grammar).
function HeaderVariantA(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
          <div className="min-w-0">
            <TitleRow token={token} />
            <ClassificationChips assetProfile={assetProfile} />
          </div>
        </div>
        <HeaderActions {...props} />
      </div>

      <div className="mt-5 grid gap-4 border-t border-border-subtle pt-4 sm:grid-cols-2">
        <MintAddressField mintAddress={token.mintAddress} onCopy={props.onCopyAddress} />
        <TokenIdField tokenId={token.id} onCopy={props.onCopyTokenId} />
      </div>
    </div>
  );
}

// Variant B — split rail: identity and actions on the left, identifiers in a
// right-hand rail behind a vertical hairline. Mirrors the AssetOverviewHero
// grammar (md:border-l divider instead of a gap) so header and hero rhyme.
function HeaderVariantB(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-start gap-4">
            <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
            <div className="min-w-0">
              <TitleRow token={token} />
              <ClassificationChips assetProfile={assetProfile} />
            </div>
          </div>
          <HeaderActions {...props} className="mt-5 lg:mt-auto lg:pt-5" />
        </div>

        <div className="flex flex-col gap-3 border-t border-border-subtle pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
          <MintAddressField mintAddress={token.mintAddress} onCopy={props.onCopyAddress} />
          <TokenIdField tokenId={token.id} onCopy={props.onCopyTokenId} />
        </div>
      </div>
    </div>
  );
}

// Variant C — banner card: identity and actions in the padded body, identifiers
// on a full-bleed tinted footer bar that anchors the card (step-review grammar,
// inverted so the tinted strip sits at the bottom).
function HeaderVariantC(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  const t = useTranslations();
  return (
    <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex flex-col gap-6 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
          <div className="min-w-0">
            <TitleRow token={token} />
            <ClassificationChips assetProfile={assetProfile} />
          </div>
        </div>
        <HeaderActions {...props} />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border-subtle bg-fill-subtle px-5 py-3">
        <InlineIdentityField icon={Wallet} label={t("DashboardIssuance.header.mintAddress")}>
          {token.mintAddress ? (
            <>
              <span className="min-w-0 truncate text-[13px] text-primary" title={token.mintAddress}>
                {token.mintAddress}
              </span>
              <CopyIconButton
                onClick={props.onCopyAddress}
                label={t("DashboardIssuance.header.copyTokenAddress")}
              />
            </>
          ) : (
            <span className="text-[13px] text-muted">
              {t("DashboardIssuance.header.notDeployed")}
            </span>
          )}
        </InlineIdentityField>

        <span className="hidden h-3.5 w-px shrink-0 bg-border-subtle lg:block" />

        <InlineIdentityField icon={Fingerprint} label={t("DashboardIssuance.header.tokenId")}>
          <span className="flex min-w-0 items-center gap-1" data-testid="token-id-row">
            <span
              className="min-w-0 text-[13px] text-primary [overflow-wrap:anywhere]"
              data-token-id-value
            >
              {token.id}
            </span>
            <CopyIconButton
              onClick={props.onCopyTokenId}
              label={t("DashboardIssuance.header.copyTokenId")}
            />
          </span>
        </InlineIdentityField>
      </div>
    </div>
  );
}

// Variant D — three columns behind vertical hairlines: logo and actions, a
// centered identity block, then the identifiers in labeled rows with icon tiles.
function HeaderVariantD(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-0">
        <div className="flex flex-col items-center justify-center gap-4 lg:pr-5">
          <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
          <HeaderActions {...props} className="justify-center" />
        </div>

        <div className="flex flex-col items-center justify-center border-border-subtle text-center lg:border-r lg:border-l lg:px-5">
          <CenteredIdentity token={token} assetProfile={assetProfile} />
        </div>

        <div className="flex flex-col justify-center lg:pl-5">
          <IdentityRows
            mintAddress={token.mintAddress}
            tokenId={token.id}
            onCopyAddress={props.onCopyAddress}
            onCopyTokenId={props.onCopyTokenId}
          />
        </div>
      </div>
    </div>
  );
}

// Variant E — classification above the name, identifiers in the middle, and a
// framed logo tile beside stacked action buttons on the right.
function HeaderVariantE(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="min-w-0">
          <ClassificationChips assetProfile={assetProfile} className="mt-0" />
          <h2 className="mt-3 truncate text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-primary">
            {token.name}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SymbolPill symbol={token.symbol} />
            <StatusPill status={token.status} />
          </div>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <OnchainAddressRow mintAddress={token.mintAddress} onCopy={props.onCopyAddress} />
          <span className="hidden h-10 w-px shrink-0 bg-border-subtle sm:block" />
          <InternalTokenIdRow tokenId={token.id} onCopy={props.onCopyTokenId} />
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden items-center justify-center rounded-2xl border border-border-default bg-fill-subtle p-3 sm:flex">
            <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
          </div>
          <HeaderActionsStacked {...props} />
        </div>
      </div>
    </div>
  );
}

// Variant F — variant D's centered composition with the actions flanking the
// name and soft contour lines decorating the background.
function HeaderVariantF(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="relative isolate overflow-hidden rounded-2xl border border-border-default bg-surface-raised p-5">
      <ContourDecoration />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-0">
        <div className="flex flex-col items-center gap-4 lg:flex-row lg:gap-5 lg:pr-5">
          <TokenAvatar imageUrl={token.imageUrl} name={token.name} symbol={token.symbol} />
          <div className="min-w-0 flex-1 text-center">
            <CenteredIdentity token={token} assetProfile={assetProfile} />
          </div>
          <HeaderActions {...props} className="justify-center lg:flex-col lg:items-stretch" />
        </div>

        <div className="flex flex-col justify-center border-border-subtle lg:border-l lg:pl-5">
          <IdentityRows
            mintAddress={token.mintAddress}
            tokenId={token.id}
            onCopyAddress={props.onCopyAddress}
            onCopyTokenId={props.onCopyTokenId}
          />
        </div>
      </div>
    </div>
  );
}

// Variant G — the boldest option: an oversized logo bleeding off the right edge
// over a dotted field, uppercase classification, and the ticker, status and
// identifiers together in a divided cell panel.
function HeaderVariantG(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  return (
    <div className="relative isolate overflow-hidden rounded-2xl border border-border-default bg-surface-raised p-5">
      <DottedDecoration />
      <BleedingLogo imageUrl={token.imageUrl} symbol={token.symbol} />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8 lg:pr-52">
        <div className="min-w-0 flex-1">
          <UppercaseClassificationRow assetProfile={assetProfile} />
          <h2 className="mt-2.5 truncate text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-primary">
            {token.name}
          </h2>
          <MetadataCellPanel {...props} />
        </div>
        <HeaderActionsStacked {...props} framed />
      </div>
    </div>
  );
}

function CenteredIdentity({ token, assetProfile }: { token: Token; assetProfile: AssetProfile }) {
  return (
    <>
      <h2 className="max-w-full text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-primary">
        {token.name}
      </h2>
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
        <SymbolPill symbol={token.symbol} />
        <StatusPill status={token.status} />
      </div>
      <ClassificationChips assetProfile={assetProfile} className="justify-center" />
    </>
  );
}

// The two identifiers as labeled rows with round icon tiles, split by a hairline.
function IdentityRows({
  mintAddress,
  tokenId,
  onCopyAddress,
  onCopyTokenId,
}: {
  mintAddress: string | null;
  tokenId: string;
  onCopyAddress: () => void;
  onCopyTokenId: () => void;
}) {
  return (
    <div className="flex flex-col">
      <OnchainAddressRow mintAddress={mintAddress} onCopy={onCopyAddress} />
      <span className="my-3 h-px bg-border-subtle" />
      <InternalTokenIdRow tokenId={tokenId} onCopy={onCopyTokenId} />
    </div>
  );
}

function IdentityIconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-fill-subtle text-tertiary">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function OnchainAddressRow({
  mintAddress,
  onCopy,
}: {
  mintAddress: string | null;
  onCopy: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <IdentityIconTile icon={Globe} />
      <div className="min-w-0">
        <p className="text-[11px] text-tertiary">{t("DashboardIssuance.header.onchainAddress")}</p>
        {mintAddress ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] text-primary" title={mintAddress}>
              {shortenAddress(mintAddress)}
            </span>
            <CopyIconButton
              onClick={onCopy}
              label={t("DashboardIssuance.header.copyTokenAddress")}
            />
          </div>
        ) : (
          <p className="text-[13px] text-muted">{t("DashboardIssuance.header.notDeployed")}</p>
        )}
      </div>
    </div>
  );
}

function InternalTokenIdRow({ tokenId, onCopy }: { tokenId: string; onCopy: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <IdentityIconTile icon={Hash} />
      <div className="min-w-0">
        <p className="text-[11px] text-tertiary">{t("DashboardIssuance.header.internalTokenId")}</p>
        <div className="flex min-w-0 items-start gap-1" data-testid="token-id-row">
          <span
            className="min-w-0 text-[13px] text-primary [overflow-wrap:anywhere]"
            data-token-id-value
          >
            {tokenId}
          </span>
          <CopyIconButton onClick={onCopy} label={t("DashboardIssuance.header.copyTokenId")} />
        </div>
      </div>
    </div>
  );
}

// Stacked action buttons; `framed` boxes them with an "or" divider (variant G).
function HeaderActionsStacked({
  token,
  explorerHref,
  canDeployToken,
  canManageTokenAdmin,
  isPending,
  deployDisabledReason,
  pauseDisabledReason,
  onDeploy,
  onUnpause,
  framed,
}: AssetProfileHeaderProps & { framed?: boolean }) {
  const t = useTranslations();
  const primaryAction = canDeployToken ? (
    <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
      <Button
        type="button"
        className="w-full"
        iconLeft={<Rocket />}
        onClick={onDeploy}
        disabled={isPending || Boolean(deployDisabledReason)}
      >
        {t("DashboardIssuance.header.deploy")}
      </Button>
    </TokenDisabledActionTooltip>
  ) : token.status === "paused" && canManageTokenAdmin ? (
    <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
      <Button
        type="button"
        className="w-full"
        iconLeft={<Play />}
        onClick={onUnpause}
        disabled={isPending || Boolean(pauseDisabledReason)}
      >
        {t("DashboardIssuance.header.unpause")}
      </Button>
    </TokenDisabledActionTooltip>
  ) : null;

  return (
    <div className="flex w-full shrink-0 flex-col gap-2 lg:w-52">
      {primaryAction}
      <div
        className={cn(
          "flex flex-col gap-2",
          framed && "rounded-xl border border-border-default p-2"
        )}
      >
        <Button variant="outline" className="w-full" asChild>
          <Link href={buildIssuancePlaygroundHref(token.id)}>
            <Terminal className="h-4 w-4" />
            {t("DashboardIssuance.playground.viewApiContext")}
          </Link>
        </Button>
        {explorerHref ? (
          <>
            {framed ? (
              <div className="flex items-center gap-2 px-1">
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="text-[11px] text-tertiary">
                  {t("DashboardIssuance.header.or")}
                </span>
                <span className="h-px flex-1 bg-border-subtle" />
              </div>
            ) : null}
            <Button variant="outline" className="w-full" asChild>
              <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
                {t("DashboardIssuance.header.explorer")}
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// Classification as quiet uppercase metadata rather than pills (variant G).
function UppercaseClassificationRow({ assetProfile }: { assetProfile: AssetProfile }) {
  const t = useTranslations();
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const entries = [category, subType].filter((entry) => entry !== null && entry !== undefined);
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {entries.map((entry, index) => {
        const Icon = entry.icon;
        return (
          <span key={entry.labelKey} className="flex items-center gap-2">
            {index > 0 ? <span className="h-3.5 w-px bg-border-subtle" /> : null}
            <span className="flex items-center gap-1.5 text-tertiary">
              <Icon className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium tracking-[0.06em] uppercase">
                {t(entry.labelKey)}
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

// Ticker, status and both identifiers as divided cells in one framed panel.
function MetadataCellPanel(props: AssetProfileHeaderProps) {
  const { token } = props;
  const t = useTranslations();
  const status = tokenStatusPresentation(t, token.status);
  return (
    <div className="mt-4 flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle sm:flex-row sm:divide-x sm:divide-y-0">
      <div className="flex min-w-0 items-center gap-2.5 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-fill-subtle text-tertiary">
          <DollarSign className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <MetadataCellLabel label={t("DashboardIssuance.header.ticker")} />
          <p className="truncate text-[13px] text-primary">{token.symbol}</p>
        </div>
      </div>

      <div className="min-w-0 px-4 py-3">
        <MetadataCellLabel label={t("DashboardIssuance.header.statusLabel")} />
        <p className="flex items-center gap-1.5 text-[13px]">
          <span className={status.textClassName}>{status.label}</span>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotClassName)} />
        </p>
      </div>

      <div className="min-w-0 px-4 py-3">
        <MetadataCellLabel label={t("DashboardIssuance.header.onchainAddress")} />
        {token.mintAddress ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] text-primary" title={token.mintAddress}>
              {shortenAddress(token.mintAddress)}
            </span>
            <CopyIconButton
              onClick={props.onCopyAddress}
              label={t("DashboardIssuance.header.copyTokenAddress")}
            />
          </div>
        ) : (
          <p className="text-[13px] text-muted">{t("DashboardIssuance.header.notDeployed")}</p>
        )}
      </div>

      <div className="min-w-0 px-4 py-3">
        <MetadataCellLabel label={t("DashboardIssuance.header.internalTokenId")} />
        <div className="flex min-w-0 items-start gap-1" data-testid="token-id-row">
          <span
            className="min-w-0 text-[13px] text-primary [overflow-wrap:anywhere]"
            data-token-id-value
          >
            {token.id}
          </span>
          <CopyIconButton
            onClick={props.onCopyTokenId}
            label={t("DashboardIssuance.header.copyTokenId")}
          />
        </div>
      </div>
    </div>
  );
}

function MetadataCellLabel({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-medium tracking-[0.06em] text-tertiary uppercase">{label}</p>
  );
}

// Oversized logo cropped by the card's right edge — decoration, so the token
// name in the heading carries the accessible label.
function BleedingLogo({ imageUrl, symbol }: { imageUrl: string | null; symbol: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 -right-10 -z-10 hidden h-52 w-52 -translate-y-1/2 lg:block"
    >
      {imageUrl ? (
        // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
        <img src={imageUrl} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-full bg-primary text-7xl font-semibold text-on-primary">
          {symbol.slice(0, 1).toUpperCase() || "?"}
        </div>
      )}
    </div>
  );
}

// Soft contour lines fading in from the right (variant F).
function ContourDecoration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 600 200"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-y-0 right-0 -z-10 h-full w-2/3 text-border-strong opacity-50"
    >
      {[0, 1, 2, 3, 4, 5, 6].map((index) => (
        <path
          key={index}
          d={`M${-40 + index * 40} 210 C ${60 + index * 40} 150, ${140 + index * 30} 90, ${300 + index * 45} -10`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

// Dotted field behind the bleeding logo (variant G).
function DottedDecoration() {
  const rawId = useId();
  const patternId = `${rawId}-dots`;
  const maskId = `${rawId}-fade`;
  const gradientId = `${rawId}-grad`;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 -z-10 h-full w-1/2 text-border-strong"
    >
      <defs>
        <pattern id={patternId} width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.1" fill="currentColor" />
        </pattern>
        <linearGradient id={gradientId} x1="0" x2="1">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="1" stopColor="white" stopOpacity="0.7" />
        </linearGradient>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill={`url(#${gradientId})`} />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} mask={`url(#${maskId})`} />
    </svg>
  );
}

function TokenAvatar({
  imageUrl,
  name,
  symbol,
}: {
  imageUrl: string | null;
  name: string;
  symbol: string;
}) {
  const t = useTranslations();
  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
      <img
        src={imageUrl}
        alt={t("DashboardIssuance.header.tokenLogo", { name })}
        className="h-16 w-16 shrink-0 rounded-full border border-border-default object-cover"
      />
    );
  }
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-border-default bg-primary text-2xl font-semibold text-on-primary">
      {symbol.slice(0, 1).toUpperCase() || "?"}
    </div>
  );
}

// Status is the only thing in this header allowed to carry colour.
function tokenStatusPresentation(
  t: ReturnType<typeof useTranslations>,
  status: Token["status"]
): { label: string; badgeClassName: string; textClassName: string; dotClassName: string } {
  const presentations: Record<
    Token["status"],
    { label: string; badgeClassName: string; textClassName: string; dotClassName: string }
  > = {
    pending: {
      label: t("DashboardIssuance.status.draft"),
      badgeClassName: "bg-fill text-secondary",
      textClassName: "text-secondary",
      dotClassName: "bg-fill-strong",
    },
    active: {
      label: t("DashboardIssuance.status.active"),
      badgeClassName: "bg-success-bg text-success",
      textClassName: "text-success",
      dotClassName: "bg-success",
    },
    paused: {
      label: t("DashboardIssuance.status.paused"),
      badgeClassName: "bg-warning-bg text-warning",
      textClassName: "text-warning",
      dotClassName: "bg-warning",
    },
    revoked: {
      label: t("DashboardIssuance.status.revoked"),
      badgeClassName: "bg-error-bg text-error",
      textClassName: "text-error",
      dotClassName: "bg-error",
    },
  };
  return presentations[status];
}

function SymbolPill({ symbol }: { symbol: string }) {
  return (
    <span className="rounded-full bg-fill px-2.5 py-0.5 text-sm font-medium text-secondary">
      {symbol}
    </span>
  );
}

function StatusPill({ status }: { status: Token["status"] }) {
  const t = useTranslations();
  const presentation = tokenStatusPresentation(t, status);
  return (
    <span
      className={cn("rounded-full px-2.5 py-0.5 text-sm font-medium", presentation.badgeClassName)}
    >
      {presentation.label}
    </span>
  );
}

function TitleRow({ token }: { token: Token }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <h2 className="truncate text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-primary">
        {token.name}
      </h2>
      <SymbolPill symbol={token.symbol} />
      <StatusPill status={token.status} />
    </div>
  );
}

function ClassificationChips({
  assetProfile,
  className,
}: {
  assetProfile: AssetProfile;
  className?: string;
}) {
  const t = useTranslations();
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  return (
    <div className={cn("mt-2.5 flex flex-wrap items-center gap-2", className)}>
      {category ? <ClassificationChip icon={category.icon} label={t(category.labelKey)} /> : null}
      {subType ? <ClassificationChip icon={subType.icon} label={t(subType.labelKey)} /> : null}
    </div>
  );
}

function ClassificationChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-surface-raised px-3 py-1 text-[13px] font-medium text-secondary">
      <Icon className="h-3.5 w-3.5 text-tertiary" />
      {label}
    </span>
  );
}

function FieldCaption({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-tertiary">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="text-[11px]">{label}</span>
    </div>
  );
}

// Label and value on one line, for the tinted footer bar in variant C.
function InlineIdentityField({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-tertiary">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
      </span>
      {children}
    </div>
  );
}

function CopyIconButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

function MintAddressField({
  mintAddress,
  onCopy,
}: {
  mintAddress: string | null;
  onCopy: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="min-w-0">
      <FieldCaption icon={Wallet} label={t("DashboardIssuance.header.mintAddress")} />
      {mintAddress ? (
        <div className="mt-0.5 flex w-fit max-w-full items-center gap-1.5">
          <span
            className="min-w-0 truncate text-[13px] font-normal text-primary"
            title={mintAddress}
          >
            {mintAddress}
          </span>
          <CopyIconButton onClick={onCopy} label={t("DashboardIssuance.header.copyTokenAddress")} />
        </div>
      ) : (
        <p className="mt-0.5 text-[13px] text-muted">{t("DashboardIssuance.header.notDeployed")}</p>
      )}
    </div>
  );
}

function TokenIdField({ tokenId, onCopy }: { tokenId: string; onCopy: () => void }) {
  const t = useTranslations();
  return (
    <div className="min-w-0">
      <FieldCaption icon={Fingerprint} label={t("DashboardIssuance.header.tokenId")} />
      <div className="mt-0.5 flex min-w-0 max-w-full items-start gap-1" data-testid="token-id-row">
        <span
          className="min-w-0 text-[13px] font-normal text-primary [overflow-wrap:anywhere]"
          data-token-id-value
        >
          {tokenId}
        </span>
        <CopyIconButton onClick={onCopy} label={t("DashboardIssuance.header.copyTokenId")} />
      </div>
    </div>
  );
}

function HeaderActions({
  token,
  explorerHref,
  canDeployToken,
  canManageTokenAdmin,
  isPending,
  deployDisabledReason,
  pauseDisabledReason,
  onDeploy,
  onUnpause,
  className,
}: AssetProfileHeaderProps & { className?: string }) {
  const t = useTranslations();
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}>
      <Button variant="outline" asChild>
        <Link href={buildIssuancePlaygroundHref(token.id)}>
          <Terminal className="h-4 w-4" />
          {t("DashboardIssuance.playground.viewApiContext")}
        </Link>
      </Button>

      {explorerHref ? (
        <Button variant="outline" asChild>
          <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
            {t("DashboardIssuance.header.explorer")}
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      ) : null}

      {canDeployToken ? (
        <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
          <Button
            type="button"
            iconLeft={<Rocket />}
            onClick={onDeploy}
            disabled={isPending || Boolean(deployDisabledReason)}
          >
            {t("DashboardIssuance.header.deploy")}
          </Button>
        </TokenDisabledActionTooltip>
      ) : token.status === "paused" && canManageTokenAdmin ? (
        <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
          <Button
            type="button"
            iconLeft={<Play />}
            onClick={onUnpause}
            disabled={isPending || Boolean(pauseDisabledReason)}
          >
            {t("DashboardIssuance.header.unpause")}
          </Button>
        </TokenDisabledActionTooltip>
      ) : null}
    </div>
  );
}
