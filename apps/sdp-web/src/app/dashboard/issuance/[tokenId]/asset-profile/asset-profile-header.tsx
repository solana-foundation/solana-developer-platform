"use client";

import type { AssetProfile, Token } from "@sdp/types";
import {
  ArrowUpRight,
  Copy,
  Globe,
  Hash,
  type LucideIcon,
  Pause,
  Play,
  Rocket,
  Terminal,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../create/asset-taxonomy";
import { tokenMarkInitial, tokenStatusPresentation } from "../../issuance-token-fields";
import { shortenAddress, shortenPrefixedId } from "../../wallet-identity";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import { type HeaderAppearance, useHeaderAppearance } from "./header-appearance";
import { buildIssuancePlaygroundHref } from "./playground-links";

// What makes a label an eyebrow: medium weight and wide tracking, no size. Size
// is the caller's, so the treatment can be applied at any scale.
const EYEBROW_TREATMENT_CLASSNAME = "font-medium tracking-[0.06em]";
// The classification row's own spec: the eyebrow treatment at metadata size.
const EYEBROW_TYPE_CLASSNAME = `text-[10px] ${EYEBROW_TREATMENT_CLASSNAME}`;

const TITLE_TYPE_CLASSNAME = "text-[32px] leading-[1.05] font-semibold tracking-[-0.4px]";

// Everything the mode changes, in one table rather than spread through the
// render: how big the mark is, whether the content is held clear of it, where the
// actions sit, and how the status is carried.
const HEADER_MODES = {
  // Everything on one line: the status rides on the address, the actions float
  // into the bottom corner beside it, and the content centres over the mark.
  default: {
    logoPx: 208,
    reserveLogoSpace: false,
    floatActions: true,
    statusStyle: "smart",
  },
  // The status spelled out, the actions on their own row under a divider, and the
  // content held clear of a larger mark.
  expanded: {
    logoPx: 256,
    reserveLogoSpace: true,
    floatActions: false,
    statusStyle: "labelled",
  },
} as const satisfies Record<
  HeaderAppearance["mode"],
  {
    logoPx: number;
    reserveLogoSpace: boolean;
    floatActions: boolean;
    statusStyle: MetaStatusStyle;
  }
>;

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

// The asset-management page header: classification eyebrow, the asset name with
// its ticker beside the mark, one hairline-separated line of identifiers, and the
// actions as type rather than boxes. Which side the mark sits on and how much the
// header spells out are set per device in Settings › Appearance.
export function AssetProfileHeader(props: AssetProfileHeaderProps) {
  const { appearance } = useHeaderAppearance();
  return <AssetProfileHeaderCard appearance={appearance} {...props} />;
}

// The header itself, with the appearance passed in rather than read — so it stays
// a pure function of its props and can be rendered at any appearance in a test.
export function AssetProfileHeaderCard({
  appearance,
  ...props
}: AssetProfileHeaderProps & { appearance: HeaderAppearance }) {
  const { token, assetProfile } = props;
  const t = useTranslations();
  const { logoPx, reserveLogoSpace, floatActions, statusStyle } = HEADER_MODES[appearance.mode];
  const logoPosition = appearance.layout === "mirrored" ? "right" : "left";
  // A stepped-down mark — low-res artwork, or none at all — never gets the hero
  // bleed, so everything measured against the logo (the reserved clearance, the
  // ticker's inset, the ticker's own size) collapses to the small-mark geometry.
  // Having no artwork is knowable here and now; artwork being too small to enlarge
  // — or failing to load at all — is only knowable once the browser has tried,
  // which is what the callback reports. Deriving the first case rather than
  // waiting for the second keeps the server render of a logoless asset identical
  // to what the client settles on.
  const [markState, setMarkState] = useState({ steppedDown: false, letterOnly: false });
  const handleSteppedDownChange = useCallback(
    (steppedDown: boolean, letterOnly: boolean) => setMarkState({ steppedDown, letterOnly }),
    []
  );
  const logoIsSteppedDown = !token.imageUrl || markState.steppedDown;
  // With no artwork the mark would spell the symbol anyway, and the pill beside it
  // would say the same thing twice — so the pill moves inside the circle and IS
  // the mark. Only artwork earns a mark-plus-pill pair.
  const tickerInsideMark = !token.imageUrl || markState.letterOnly;
  const actionNodes = (
    <>
      <QuietActionLink
        href={buildIssuancePlaygroundHref(token.id)}
        icon={Terminal}
        label={t("DashboardIssuance.playground.viewApiContext")}
      />
      <PrimaryTokenAction {...props} />
      {props.explorerHref ? (
        <QuietActionLink
          href={props.explorerHref}
          external
          trailingIcon={ArrowUpRight}
          label={t("DashboardIssuance.header.explorer")}
        />
      ) : null}
    </>
  );
  // The exchange-ticker face, loaded in layout.tsx via next/font — the one
  // deliberate exception to the Inter-only rule. `font-semibold` must stay in
  // step with the single weight loaded there, or the browser synthesises one.
  // Tabular figures keep numeric symbols on a grid, and casing is left exactly as
  // the issuer typed the symbol. The eyebrow treatment on top of that is what
  // ties it to the classification row above the name. A function rather than a
  // node because the pill renders at more than one size in the same header.
  const renderTicker = (typeClassName: string) => (
    <p
      className={cn(
        "tabular-nums [font-family:var(--font-ticker-archivo)]",
        EYEBROW_TREATMENT_CLASSNAME,
        "font-semibold text-primary",
        "inline-flex w-fit items-center rounded-full bg-fill px-2.5 py-0.5",
        typeClassName
      )}
    >
      <span className="sr-only">{t("DashboardIssuance.header.ticker")}</span>
      {token.symbol}
    </p>
  );
  // A stepped-down mark pulls the ticker down with it, so the symbol never
  // outweighs the artwork beside it. Even against the hero bleed the pill stays a
  // step under the title's scale — it annotates the name, it doesn't compete.
  const ticker = renderTicker(logoIsSteppedDown ? "text-sm" : "text-base");
  // The mark is out of flow, so `reserve` pads the content clear of it and the
  // title centres in the space that is left. Without it the title centres against
  // the card's own edges and the mark sits behind it.
  const contentPadding = reserveLogoSpace
    ? {
        right: logoIsSteppedDown ? "lg:pr-40" : "lg:pr-64",
        left: logoIsSteppedDown ? "lg:pl-40" : "lg:pl-64",
      }[logoPosition]
    : null;
  // The ticker sits just inside the mark's near edge, vertically centred on it. A
  // stepped-down low-res mark gets a wider gap: it is small, hairlined and
  // hard-edged, so the clearance that reads as "beside the logo" against a
  // full-bleed mark reads as "touching it" here. Both insets measure from the
  // same 120px inner edge (LOGO_SMALL_BOX_PX minus LOGO_BLEED_PX), which is where
  // a low-res mark is always placed.
  const tickerInset = logoIsSteppedDown
    ? { right: "right-[132px]", left: "left-[132px]" }[logoPosition]
    : {
        right: logoPx === 256 ? "right-[220px]" : "right-[172px]",
        left: logoPx === 256 ? "left-[220px]" : "left-[172px]",
      }[logoPosition];

  return (
    <div className="relative isolate overflow-hidden rounded-2xl border border-border-default bg-surface-raised p-5">
      <BleedingLogo
        imageUrl={token.imageUrl}
        symbol={token.symbol}
        position={logoPosition}
        size={logoPx}
        // Under 1024px there is no room for a mark beside the content. The default
        // already centres the content over it, so the mark stays as a small round
        // avatar above the content; expanded has nothing to reserve down there.
        belowLg={reserveLogoSpace ? "hide" : "avatar"}
        onSteppedDownChange={handleSteppedDownChange}
        tickerPill={renderTicker(tickerPillTypeClassName(token.symbol))}
      />

      {/* Beside the mark only when the mark is artwork — a letter-only mark
          carries the pill itself, and a second one would say it twice. */}
      {tickerInsideMark ? null : (
        <div className={cn("absolute top-1/2 hidden -translate-y-1/2 lg:block", tickerInset)}>
          {ticker}
        </div>
      )}

      <div className={cn("flex flex-col items-center text-center", contentPadding)}>
        <UppercaseClassificationRow assetProfile={assetProfile} className="justify-center" />

        <div className="mt-2.5 flex max-w-full flex-col items-center justify-center gap-1">
          <h2 className={cn(TITLE_TYPE_CLASSNAME, "text-primary")}>{token.name}</h2>
          {/* Below lg the ticker has no mark to sit beside, so it stacks under the
              name instead. When the desktop pill lives inside the aria-hidden
              mark, this copy stays in the accessibility tree at every width
              rather than leaving desktop readers without a ticker. */}
          <div className={tickerInsideMark ? "lg:sr-only" : "lg:hidden"}>{ticker}</div>
        </div>

        <MetaLine
          token={token}
          statusStyle={statusStyle}
          onCopyAddress={props.onCopyAddress}
          onCopyTokenId={props.onCopyTokenId}
        />

        <div
          className={cn(
            "mt-4 flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-3 border-t border-border-subtle pt-4",
            floatActions && "lg:hidden"
          )}
        >
          {actionNodes}
        </div>
      </div>

      {/* Floated to the bottom of the side the mark is not on — but only once
          there is room: below lg it falls back to the in-flow row above. */}
      {floatActions ? (
        <div
          className={cn(
            "absolute bottom-5 z-10 hidden flex-wrap items-center gap-x-5 gap-y-2 lg:flex",
            logoPosition === "right" ? "left-5" : "right-5"
          )}
        >
          {actionNodes}
        </div>
      ) : null}
    </div>
  );
}

// How the meta line carries the status. `labelled` spells it out as a dot and a
// word; `smart` puts the two live states on the address field's own glyph.
type MetaStatusStyle = "labelled" | "smart";

// Status, on-chain address and internal token id as one hairline-separated row.
// Two of the three segments are conditional — the status can move onto the
// address, and an undeployed token has no address — so separators are interleaved
// rather than written between fixed items, which would leave a divider dangling
// as soon as a neighbour drops out.
function MetaLine({
  token,
  statusStyle,
  onCopyAddress,
  onCopyTokenId,
}: {
  token: Token;
  statusStyle: MetaStatusStyle;
  onCopyAddress: () => void;
  onCopyTokenId: () => void;
}) {
  const t = useTranslations();
  const status = tokenStatusPresentation(t, token.status);
  // A running token's state reads as a footnote rather than a headline: active is
  // the globe in the status colour, paused swaps the globe for a pause mark.
  const smartStatusIcon =
    statusStyle === "smart"
      ? { active: Globe, paused: Pause, pending: null, revoked: null }[token.status]
      : null;
  // The state rides on the address, so it needs one to ride on.
  const statusOnAddress = Boolean(smartStatusIcon && token.mintAddress);
  const AddressIcon = statusOnAddress && smartStatusIcon ? smartStatusIcon : Globe;
  const addressIcon = (
    <AddressIcon
      className={cn("h-3 w-3 shrink-0", statusOnAddress ? status.textClassName : "text-tertiary")}
      aria-hidden="true"
    />
  );
  // Smart drops the draft label: an undeployed token has no address and offers
  // Deploy, which says it already. Revoked still gets the labelled dot — a
  // terminal state has to say so in words.
  const showStatusSegment =
    statusStyle === "labelled" ||
    (statusStyle === "smart" && !statusOnAddress && token.status !== "pending");
  const segments: { key: string; node: React.ReactNode }[] = [];
  if (showStatusSegment) {
    segments.push({
      key: "status",
      node: (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotClassName)} />
          <span className="sr-only">{t("DashboardIssuance.header.statusLabel")}</span>
          <span className={status.textClassName}>{status.label}</span>
        </span>
      ),
    });
  }
  if (token.mintAddress) {
    segments.push({
      key: "address",
      node: (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {/* One glyph, not two: in smart mode the field's own icon carries the
              state through colour and shape, so the tooltip and the sr-only
              label are what name it. */}
          {statusOnAddress ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center">
                    {addressIcon}
                    <span className="sr-only">
                      {t("DashboardIssuance.header.statusLabel")} {status.label}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  {status.label}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            addressIcon
          )}
          <span className="sr-only">{t("DashboardIssuance.header.onchainAddress")}</span>
          <span className="text-primary" title={token.mintAddress}>
            {shortenAddress(token.mintAddress)}
          </span>
          <CopyIconButton
            onClick={onCopyAddress}
            label={t("DashboardIssuance.header.copyTokenAddress")}
          />
        </span>
      ),
    });
  }
  segments.push({
    key: "tokenId",
    node: (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Hash className="h-3 w-3 shrink-0 text-tertiary" aria-hidden="true" />
        <span className="sr-only">{t("DashboardIssuance.header.internalTokenId")}</span>
        {/* Read like the address beside it: one line, middle elided, the whole
            value on hover and on the clipboard. */}
        <span className="inline-flex items-center gap-1" data-testid="token-id-row">
          <span className="text-primary" data-token-id-value title={token.id}>
            {shortenPrefixedId(token.id)}
          </span>
          <CopyIconButton
            onClick={onCopyTokenId}
            label={t("DashboardIssuance.header.copyTokenId")}
          />
        </span>
      </span>
    ),
  });

  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px]">
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 ? <MetaSeparator /> : null}
          {segment.node}
        </Fragment>
      ))}
    </div>
  );
}

function MetaSeparator() {
  return <span aria-hidden="true" className="hidden h-3 w-px bg-border-subtle sm:block" />;
}

// An action rendered as type rather than a button.
function QuietActionLink({
  href,
  label,
  icon: Icon,
  trailingIcon: TrailingIcon,
  external,
}: {
  href: string;
  label: string;
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(QUIET_ACTION_CLASSNAME, "text-secondary hover:text-primary")}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {label}
      {TrailingIcon ? <TrailingIcon className="h-3.5 w-3.5" /> : null}
    </Link>
  );
}

// The action row is type, not boxes — a filled button would be the only framed
// thing on the card. Every action shares this spec so the row reads
// as one group.
const QUIET_ACTION_CLASSNAME =
  "inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors";

// The one action that isn't a link. It leads on contrast rather than on a fill:
// full contrast where the links sit a step down, and it dims on hover because
// there is no higher step to move to.
function QuietActionButton({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        QUIET_ACTION_CLASSNAME,
        "text-primary hover:text-secondary",
        "disabled:cursor-not-allowed disabled:text-muted disabled:hover:text-muted"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// The primary action for the token's current state: deploy, or unpause a paused
// token.
function PrimaryTokenAction({
  token,
  canDeployToken,
  canManageTokenAdmin,
  isPending,
  deployDisabledReason,
  pauseDisabledReason,
  onDeploy,
  onUnpause,
}: AssetProfileHeaderProps) {
  const t = useTranslations();
  if (canDeployToken) {
    return (
      <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
        <QuietActionButton
          icon={Rocket}
          label={t("DashboardIssuance.header.deploy")}
          onClick={onDeploy}
          disabled={isPending || Boolean(deployDisabledReason)}
        />
      </TokenDisabledActionTooltip>
    );
  }
  if (token.status === "paused" && canManageTokenAdmin) {
    return (
      <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
        <QuietActionButton
          icon={Play}
          label={t("DashboardIssuance.header.unpause")}
          onClick={onUnpause}
          disabled={isPending || Boolean(pauseDisabledReason)}
        />
      </TokenDisabledActionTooltip>
    );
  }
  return null;
}

// Classification as quiet uppercase metadata rather than pills (variant G).
function UppercaseClassificationRow({
  assetProfile,
  className,
}: {
  assetProfile: AssetProfile;
  className?: string;
}) {
  const t = useTranslations();
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const entries = [category, subType].filter((entry) => entry !== null && entry !== undefined);
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      {entries.map((entry, index) => {
        const Icon = entry.icon;
        return (
          <span key={entry.labelKey} className="flex items-center gap-2">
            {index > 0 ? <span className="h-3.5 w-px bg-border-subtle" /> : null}
            <span className="flex items-center gap-1.5 text-tertiary">
              <Icon className="h-3.5 w-3.5" />
              <span className={cn(EYEBROW_TYPE_CLASSNAME, "uppercase")}>{t(entry.labelKey)}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

function tickerPillTypeClassName(symbol: string): string {
  if (symbol.length >= 10) {
    return "text-xs";
  }
  return symbol.length >= 8 ? "text-sm" : "text-base";
}

// Oversized logo cropped by the card's right edge — decoration, so the token
// name in the heading carries the accessible label.
function BleedingLogo({
  imageUrl,
  symbol,
  position = "right",
  size = 208,
  belowLg = "hide",
  onSteppedDownChange,
  tickerPill,
}: {
  imageUrl: string | null;
  symbol: string;
  position?: "left" | "right";
  size?: number;
  // What happens below lg, where there is no room beside the content. `hide` is
  // for reserved-space layouts: the clearance the mark was placed against no
  // longer exists, so the mark goes with it. `avatar` keeps the logo present by
  // changing what it is — a small round avatar in flow above the content, rather
  // than a full-size mark behind the type.
  belowLg?: "hide" | "avatar";
  // Reports whenever the mark steps down to the small geometry instead of filling
  // the hero bleed — and, separately, whether what it shows is letters rather
  // than artwork — so the header can scale type and spacing to the mark it
  // actually got. Must be referentially stable — pass a useCallback.
  onSteppedDownChange?: (isSteppedDown: boolean, isLetterOnly: boolean) => void;
  // What the stepped-down circle shows when there is no artwork to show: the
  // ticker pill takes the letter mark's place, so the symbol is set once, in the
  // mark, rather than beside it. The 56px avatar keeps its monogram — a pill
  // does not fit in it.
  tickerPill?: React.ReactNode;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [quality, setQuality] = useState<LogoQuality>("pending");
  const [naturalSize, setNaturalSize] = useState(0);
  const [failed, setFailed] = useState(false);

  const measure = useCallback(
    (image: HTMLImageElement) => {
      if (!imageUrl) {
        return;
      }
      const resolved = resolveLogoQuality({
        url: imageUrl,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        boxSize: size,
      });
      if (resolved === "unusable") {
        setFailed(true);
        return;
      }
      setNaturalSize(Math.min(image.naturalWidth, image.naturalHeight));
      setQuality(resolved);
    },
    [imageUrl, size]
  );

  // A cached image can finish loading before hydration attaches onLoad, so
  // re-measure on mount. Also re-runs when the source or box size changes.
  useEffect(() => {
    setQuality("pending");
    setFailed(false);
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth) {
      measure(image);
    }
  }, [measure]);

  const hasArtwork = Boolean(imageUrl) && !failed;
  // Two reasons a mark can't carry the hero bleed: artwork with too few pixels to
  // enlarge, and no artwork at all. Blowing a letterform up to 208px makes a wall
  // of flat colour that outweighs everything else on the card, so both step down
  // to the same modest circle.
  const isSteppedDown = (quality === "lowRes" && hasArtwork) || !hasArtwork;
  useEffect(() => {
    onSteppedDownChange?.(isSteppedDown, !hasArtwork);
  }, [isSteppedDown, hasArtwork, onSteppedDownChange]);

  // The narrow-screen stand-in: same artwork, different object. It sits in flow
  // at the top of the card, so nothing reads through the type — and at this size
  // even a modest source is sharp, so it needs none of the quality logic.
  const avatar =
    belowLg === "avatar" ? (
      <div
        aria-hidden="true"
        className="mx-auto mb-4 h-14 w-14 shrink-0 overflow-hidden rounded-full border border-border-subtle lg:hidden"
      >
        {imageUrl && !failed ? (
          // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
          <img
            src={imageUrl}
            alt=""
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          // A 56px circle has room for a monogram, not a symbol.
          <LogoLetterMark label={tokenMarkInitial(symbol)} className="px-0 text-lg" />
        )}
      </div>
    ) : null;

  if (isSteppedDown) {
    const markSize = hasArtwork ? Math.min(naturalSize, LOGO_LOWRES_MAX_PX) : LOGO_TICKER_MARK_PX;
    const offset = hasArtwork
      ? Math.max(LOGO_LOWRES_MIN_OFFSET_PX, LOGO_SMALL_BOX_PX - LOGO_BLEED_PX - markSize)
      : LOGO_TICKER_MARK_OFFSET_PX;
    return (
      <>
        {avatar}
        <div
          aria-hidden="true"
          style={{
            height: markSize,
            width: markSize,
            ...(position === "right" ? { right: offset } : { left: offset }),
          }}
          className="pointer-events-none absolute top-1/2 -z-10 hidden -translate-y-1/2 overflow-hidden rounded-full border border-border-subtle lg:block"
        >
          {hasArtwork && imageUrl ? (
            // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
            <img
              ref={imageRef}
              src={imageUrl}
              alt=""
              onError={() => setFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : tickerPill ? (
            // The pill on the letter mark's tint: the circle still reads as a
            // placeholder for artwork, but the symbol in it is the ticker, set
            // once instead of repeated beside the mark.
            <div className="flex h-full w-full items-center justify-center bg-fill-subtle">
              {tickerPill}
            </div>
          ) : (
            <LogoLetterMark label={symbol.trim() || "?"} />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {avatar}
      <div
        aria-hidden="true"
        style={{ height: size, width: size }}
        className={cn(
          "pointer-events-none absolute top-1/2 -z-10 hidden -translate-y-1/2 lg:block",
          position === "right" ? "-right-10" : "-left-10"
        )}
      >
        {/* biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here. */}
        <img
          ref={imageRef}
          src={imageUrl ?? undefined}
          alt=""
          onLoad={(event) => measure(event.currentTarget)}
          onError={() => setFailed(true)}
          className={cn(
            "h-full w-full rounded-full object-cover transition-opacity",
            quality === "pending" && "opacity-0"
          )}
        />
      </div>
    </>
  );
}

// Below this the source carries too little detail to be worth showing at all.
const LOGO_MIN_USABLE_PX = 64;

// A logo that can't fill the hero bleed is shown at most this big.
const LOGO_LOWRES_MAX_PX = 96;

// How far the full-size logo hangs off the card edge (-right-10 / -left-10).
const LOGO_BLEED_PX = 40;

// Keeps a stepped-down mark clear of the card edge.
const LOGO_LOWRES_MIN_OFFSET_PX = 20;

// The ticker mark: the circle that carries the pill when there is no artwork.
// Bigger than a low-res mark — it holds type, not pixels — and inset further, so
// it sits with the title rather than against the card edge. Its outer edge stays
// inside the 160px clearance the expanded mode reserves (32 + 120 < 160).
const LOGO_TICKER_MARK_PX = 120;
const LOGO_TICKER_MARK_OFFSET_PX = 32;

// The small-mark box. A stepped-down mark is always placed against this
// geometry, so a low-res logo sits in the same place whichever mode is on — the
// mode scales the hero bleed, which a low-res source never gets.
const LOGO_SMALL_BOX_PX = 160;

function isVectorLogo(url: string): boolean {
  return /^data:image\/svg\+xml/i.test(url) || /\.svg($|[?#])/i.test(url);
}

type LogoQuality = "pending" | "sharp" | "lowRes";

/**
 * Decides how a logo source may be presented at `boxSize` CSS pixels.
 *
 * - `sharp`: vector, or enough pixels to fill the box without upscaling.
 * - `lowRes`: real artwork, but fewer pixels than the box — show it inset at its
 *   own resolution rather than blowing it up.
 * - `unusable`: too little detail to show at all; use the letter mark.
 *
 * `naturalWidth`/`naturalHeight` of 0 means the browser reported no intrinsic
 * size, which happens for SVGs declaring only a viewBox — those scale, so they
 * count as sharp.
 */
export function resolveLogoQuality({
  url,
  naturalWidth,
  naturalHeight,
  boxSize,
}: {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
  boxSize: number;
}): "sharp" | "lowRes" | "unusable" {
  if (isVectorLogo(url)) {
    return "sharp";
  }
  const natural = Math.min(naturalWidth, naturalHeight);
  if (!natural) {
    return "sharp";
  }
  if (natural < LOGO_MIN_USABLE_PX) {
    return "unusable";
  }
  return natural >= boxSize ? "sharp" : "lowRes";
}

// The mark carries the whole symbol rather than a prefix, so the type steps down
// as the symbol lengthens. Sized against the stepped-down circle
// (LOGO_LOWRES_MAX_PX) less its inset, so ten characters still fit inside it.
const LETTER_MARK_TYPE_BY_LENGTH = [
  "text-2xl",
  "text-2xl",
  "text-xl",
  "text-lg",
  "text-base",
  "text-sm",
  "text-xs",
  "text-xs",
  "text-[10px]",
  "text-[10px]",
] as const;

export function letterMarkTypeClassName(label: string): string {
  return LETTER_MARK_TYPE_BY_LENGTH[label.length - 1] ?? "text-[10px]";
}

// The stand-in when an asset has no artwork. The caller decides how much of the
// ticker to set — the whole symbol in the stepped-down mark, a monogram in the
// small avatar — and the type sizes itself to whatever it is given. Deliberately
// quiet: it stands in for artwork the issuer hasn't supplied, so it reads as a
// placeholder rather than as a brand.
function LogoLetterMark({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-fill-subtle px-3 text-center leading-none font-semibold tracking-tight text-tertiary",
        letterMarkTypeClassName(label),
        className
      )}
    >
      {label}
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
