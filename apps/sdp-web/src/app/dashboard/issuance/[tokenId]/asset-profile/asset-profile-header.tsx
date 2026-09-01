"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ArrowUpRightIcon, CopyIcon, PlayIcon, RocketIcon, TerminalIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../create/asset-taxonomy";
import { tokenMarkInitial, tokenStatusPresentation } from "../../issuance-token-fields";
import { shortenAddress, shortenPrefixedId } from "../../wallet-identity";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import { formatDate } from "../token-management-workspace.utils";
import { buildIssuancePlaygroundHref } from "./playground-links";

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

// The asset-management page header as one identity column: a small round mark,
// the asset name with its ticker chip beside it, one dot-separated line of
// classification / status / deploy date, the two identifiers under that, and
// the actions as buttons in the top-right corner.
export function AssetProfileHeader(props: AssetProfileHeaderProps) {
  const { token, assetProfile } = props;
  const t = useTranslations();
  const locale = useLocale();
  const status = tokenStatusPresentation(t, token.status);
  const classificationEntries = [
    getCategoryPresentation(assetProfile.assetCategory),
    getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType),
  ].filter((entry) => entry !== null && entry !== undefined);
  const metaSegments: { key: string; node: React.ReactNode }[] = [
    ...classificationEntries.map((entry) => ({
      key: entry.labelKey,
      node: <span>{t(entry.labelKey)}</span>,
    })),
    {
      key: "status",
      node: (
        <span className={cn("inline-flex items-center gap-1.5 font-medium", status.textClassName)}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotClassName)} />
          <span className="sr-only">{t("DashboardIssuance.header.statusLabel")}</span>
          {status.label}
        </span>
      ),
    },
    ...(token.deployedAt
      ? [
          {
            key: "deployed",
            node: (
              <span>
                {t("DashboardIssuance.header.deployedOn", {
                  date: formatDate(token.deployedAt, locale),
                })}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <TokenLogo imageUrl={token.imageUrl} symbol={token.symbol} />

          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <h2 className="text-2xl font-semibold tracking-tight text-primary">{token.name}</h2>
              <span className="rounded-md bg-fill px-1.5 py-0.5 text-xs font-semibold text-secondary">
                <span className="sr-only">{t("DashboardIssuance.header.ticker")} </span>
                {token.symbol}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
              {metaSegments.map((segment, index) => (
                <Fragment key={segment.key}>
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-muted">
                      &middot;
                    </span>
                  ) : null}
                  {segment.node}
                </Fragment>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {token.mintAddress ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="text-tertiary">{t("DashboardIssuance.header.mint")}</span>
                  <span className="text-primary" title={token.mintAddress}>
                    {shortenAddress(token.mintAddress)}
                  </span>
                  <CopyIconButton
                    onClick={props.onCopyAddress}
                    label={t("DashboardIssuance.header.copyTokenAddress")}
                  />
                </span>
              ) : null}
              {/* Elided like the address beside it: one line, middle elided, the
                  whole value on hover and on the clipboard. */}
              <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="token-id-row">
                <span className="text-tertiary">{t("DashboardIssuance.header.tokenId")}</span>
                <span className="text-secondary" data-token-id-value title={token.id}>
                  {shortenPrefixedId(token.id)}
                </span>
                <CopyIconButton
                  onClick={props.onCopyTokenId}
                  label={t("DashboardIssuance.header.copyTokenId")}
                />
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={buildIssuancePlaygroundHref(token.id)}>
              <TerminalIcon className="h-3.5 w-3.5" />
              {t("DashboardIssuance.playground.viewApiContext")}
            </Link>
          </Button>
          {props.explorerHref ? (
            <Button asChild variant="secondary" size="sm">
              <a href={props.explorerHref} target="_blank" rel="noopener noreferrer">
                {t("DashboardIssuance.header.explorer")}
                <ArrowUpRightIcon className="h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
          <PrimaryTokenAction {...props} />
        </div>
      </div>
    </div>
  );
}

// The 44px identity mark: the issuer's artwork, or a quiet monogram standing in
// for artwork they haven't supplied.
function TokenLogo({ imageUrl, symbol }: { imageUrl: string | null; symbol: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden="true"
      className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-border-subtle"
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
        <div className="flex h-full w-full items-center justify-center bg-fill-subtle text-sm font-semibold text-tertiary">
          {tokenMarkInitial(symbol)}
        </div>
      )}
    </div>
  );
}

// The primary action for the token's current state: deploy, or unpause a paused
// token. The one filled button in the row — everything else stays quiet.
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
        <Button
          type="button"
          size="sm"
          iconLeft={<RocketIcon />}
          onClick={onDeploy}
          disabled={isPending || Boolean(deployDisabledReason)}
        >
          {t("DashboardIssuance.header.deploy")}
        </Button>
      </TokenDisabledActionTooltip>
    );
  }
  if (token.status === "paused" && canManageTokenAdmin) {
    return (
      <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
        <Button
          type="button"
          size="sm"
          iconLeft={<PlayIcon />}
          onClick={onUnpause}
          disabled={isPending || Boolean(pauseDisabledReason)}
        >
          {t("DashboardIssuance.header.unpause")}
        </Button>
      </TokenDisabledActionTooltip>
    );
  }
  return null;
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
      <CopyIcon className="h-3.5 w-3.5" />
    </button>
  );
}
