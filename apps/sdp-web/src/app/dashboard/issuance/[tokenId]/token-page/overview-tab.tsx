"use client";

import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { RecordAmount } from "@/app/dashboard/payments/payments-record";
import {
  RecordBlock,
  RecordColumns,
  RecordLine,
  RecordRow,
  RecordStack,
  StateBand,
} from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { StatusText } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  formatTokenDay,
  formatTokenMoment,
  isOnChain,
  TOKEN_LIFECYCLE_BAND,
  TOKEN_LIFECYCLE_LABEL,
  TOKEN_LIFECYCLE_WHY,
} from "../../issuance-token-state.redesign";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import type { PermissionRowId } from "../token-management-workspace.types";
import {
  activityActorType,
  activityEventLabel,
  activityStatus,
  useTokenActivity,
} from "./token-activity";
import {
  accessControlLabel,
  classificationOf,
  type LatestDeployAttempt,
  shortAddress,
  shortTokenId,
  type TokenTab,
  type TokenTabProps,
} from "./token-page.shared";

const AUTHORITY_SHORT: Record<PermissionRowId, MessageKey> = {
  "mint-authority": "DashboardIssuance.newDesign.overview.authority.mint",
  "freeze-authority": "DashboardIssuance.newDesign.overview.authority.freeze",
  "metadata-authority": "DashboardIssuance.newDesign.overview.authority.metadata",
  "permanent-delegate": "DashboardIssuance.newDesign.overview.authority.delegate",
};

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

/**
 * The token at a glance: its state and the one thing it asks for, the issued supply over the
 * token's terms, who and what it is, and its two latest events.
 */
export function TokenOverviewTab({
  token,
  assetProfile,
  ops,
  form,
  state,
  canManageTokenAdmin,
  latestDeploy,
  onOpenTab,
}: TokenTabProps & {
  latestDeploy: LatestDeployAttempt | null;
  onOpenTab: (tab: TokenTab) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const classification = classificationOf(assetProfile, t);
  const onChain = isOnChain(state);
  const signingWalletId = token.signingCustodyWalletId ?? form.draft.signingWalletId;
  const signingWallet = ops.authorityWallets.find((wallet) => wallet.id === signingWalletId);
  const signingWalletName =
    signingWallet?.label?.trim() ||
    (signingWallet
      ? shortAddress(signingWallet.publicKey)
      : t("DashboardIssuance.newDesign.notSet"));
  const heldAuthorities = ops.permissionRows.filter((row) => row.value || !onChain);
  const deployBlocked = form.dirty
    ? t("DashboardIssuance.simplified.saveBeforeDeploy")
    : (form.errors.authorityWalletIds ?? ops.deployDisabledReason);
  const deploy = () =>
    ops.deployToken({
      ...form.draft.authorityWalletIds,
      "mint-authority": form.draft.signingWalletId,
    });
  const failedWhy =
    state === "failed" && latestDeploy?.error ? latestDeploy.error : t(TOKEN_LIFECYCLE_WHY[state]);
  const deployButton = (label: string) => (
    <TokenDisabledActionTooltip reason={canManageTokenAdmin ? deployBlocked : null}>
      <Button
        size="sm"
        onClick={deploy}
        disabled={!canManageTokenAdmin || ops.isPending || Boolean(deployBlocked)}
      >
        {label}
      </Button>
    </TokenDisabledActionTooltip>
  );

  return (
    <RecordStack>
      {/* The state band sits 32px over what follows it, closer than the parts below. */}
      <div className="flex flex-col gap-8">
        <StateBand
          tone={TOKEN_LIFECYCLE_BAND[state]}
          state={t(TOKEN_LIFECYCLE_LABEL[state])}
          action={
            ops.explorerHref ? (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="[--button-height-md:1.875rem]"
                iconRight={<ExternalLinkIcon aria-hidden="true" />}
              >
                <a href={ops.explorerHref} target="_blank" rel="noreferrer">
                  {t("DashboardIssuance.newDesign.overview.explorer")}
                </a>
              </Button>
            ) : state === "deploying" && latestDeploy ? (
              <span className="text-meta text-secondary">
                {t("DashboardIssuance.newDesign.overview.submittedAgo", {
                  minutes: minutesSince(latestDeploy.createdAt),
                })}
              </span>
            ) : undefined
          }
        >
          {t(TOKEN_LIFECYCLE_WHY[state])}
        </StateBand>

        {state === "draft" ? (
          <RecordBlock title={t("DashboardIssuance.newDesign.overview.deployTitle")}>
            <p className="max-w-[40em] text-body text-secondary">
              {t("DashboardIssuance.newDesign.overview.deployBody")}
            </p>
            <dl>
              <RecordLine label={t("DashboardIssuance.newDesign.overview.signingWallet")}>
                {signingWalletName}
              </RecordLine>
              <RecordLine label={t("DashboardIssuance.newDesign.overview.authorities")}>
                {t("DashboardIssuance.newDesign.overview.authoritiesDraft")}
              </RecordLine>
              <RecordLine label={t("DashboardIssuance.newDesign.overview.reversible")}>
                {t("DashboardIssuance.newDesign.overview.reversibleNo")}
              </RecordLine>
            </dl>
            <div className="flex items-center justify-end gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/issuance">
                  {t("DashboardIssuance.newDesign.overview.notNow")}
                </Link>
              </Button>
              {deployButton(t("DashboardIssuance.newDesign.overview.deployToken"))}
            </div>
          </RecordBlock>
        ) : null}

        {state === "failed" ? (
          <div className="flex flex-col items-start gap-4">
            <p className="max-w-[40em] text-body text-secondary">{failedWhy}</p>
            <div className="flex items-center gap-2">
              {deployButton(t("DashboardIssuance.newDesign.overview.retryDeploy"))}
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/wallets">
                  {t("DashboardIssuance.newDesign.overview.openWallets")}
                </Link>
              </Button>
            </div>
          </div>
        ) : null}

        {state === "paused" && canManageTokenAdmin ? (
          <div className="flex flex-col items-start gap-4">
            <p className="max-w-[40em] text-body text-secondary">
              {t("DashboardIssuance.newDesign.overview.resumeBody")}
            </p>
            <TokenDisabledActionTooltip reason={ops.effectivePauseDisabledReason}>
              <Button
                size="sm"
                disabled={ops.isPending || Boolean(ops.effectivePauseDisabledReason)}
                onClick={() => ops.handlePause(false)}
              >
                {t("DashboardIssuance.newDesign.overview.resumeTransfers")}
              </Button>
            </TokenDisabledActionTooltip>
          </div>
        ) : null}

        <RecordBlock>
          <RecordAmount label={t("DashboardIssuance.newDesign.overview.issuedSupply")}>
            {formatDecimalAmount(token.totalSupply || "0", locale)}
          </RecordAmount>
          <RecordColumns>
            <dl>
              <RecordRow label={t("DashboardIssuance.newDesign.overview.supplyCap")}>
                {token.maxSupply
                  ? formatDecimalAmount(token.maxSupply, locale)
                  : t("DashboardIssuance.newDesign.overview.noCap")}
              </RecordRow>
              <RecordRow label={t("DashboardIssuance.newDesign.overview.decimals")}>
                {token.decimals}
              </RecordRow>
              <RecordRow label={t("DashboardIssuance.newDesign.overview.symbol")}>
                {token.symbol}
              </RecordRow>
            </dl>
            <dl>
              <RecordRow
                label={t("DashboardIssuance.newDesign.overview.category")}
                hint={classification.categoryHelp}
              >
                {classification.category}
              </RecordRow>
              {classification.type ? (
                <RecordRow label={t("DashboardIssuance.newDesign.overview.type")}>
                  {classification.type}
                </RecordRow>
              ) : null}
              <RecordRow label={t("DashboardIssuance.newDesign.overview.accessControl")}>
                {accessControlLabel(ops.accessControlMode, t)}
              </RecordRow>
            </dl>
          </RecordColumns>
          <dl className="border-t border-border-subtle">
            <RecordRow label={t("DashboardIssuance.newDesign.overview.description")}>
              <span className="max-w-[40em] text-right whitespace-normal">
                {token.description || t("DashboardIssuance.newDesign.overview.noDescription")}
              </span>
            </RecordRow>
          </dl>
        </RecordBlock>
      </div>

      <RecordBlock title={t("DashboardIssuance.newDesign.overview.identity")}>
        <RecordColumns>
          <dl>
            {token.mintAddress ? (
              <RecordRow label={t("DashboardIssuance.newDesign.overview.mintAddress")}>
                <span className="tabular-nums">{shortAddress(token.mintAddress)}</span>
                <span className="-my-1 inline-flex">
                  <WalletMetadataCopyButton
                    value={token.mintAddress}
                    label={t("DashboardIssuance.newDesign.overview.copyMintAddress")}
                  />
                </span>
              </RecordRow>
            ) : null}
            <RecordRow label={t("DashboardIssuance.newDesign.overview.tokenId")}>
              <span className="tabular-nums">{shortTokenId(token.id)}</span>
              <span className="-my-1 inline-flex">
                <WalletMetadataCopyButton
                  value={token.id}
                  label={t("DashboardIssuance.newDesign.overview.copyTokenId")}
                />
              </span>
            </RecordRow>
            <RecordRow
              label={t("DashboardIssuance.newDesign.overview.authorities")}
              hint={heldAuthorities.map((row) => `${row.title}: ${row.helper}`).join(" ")}
            >
              {heldAuthorities.length
                ? heldAuthorities.map((row) => t(AUTHORITY_SHORT[row.id])).join(", ")
                : t("DashboardIssuance.newDesign.permissions.nobody")}
            </RecordRow>
          </dl>
          <dl>
            <RecordRow label={t("DashboardIssuance.newDesign.overview.issuerName")}>
              {form.draft.issuerName.trim() || t("DashboardIssuance.newDesign.notSet")}
            </RecordRow>
            <RecordRow label={t("DashboardIssuance.newDesign.overview.signingWallet")}>
              {signingWalletName}
            </RecordRow>
            {onChain && token.deployedAt ? (
              <RecordRow label={t("DashboardIssuance.newDesign.overview.deployed")}>
                {formatTokenDay(token.deployedAt, locale)}
              </RecordRow>
            ) : (
              <RecordRow label={t("DashboardIssuance.newDesign.overview.created")}>
                {formatTokenDay(token.createdAt, locale)}
              </RecordRow>
            )}
          </dl>
        </RecordColumns>
      </RecordBlock>

      <RecentActivity tokenId={token.id} onViewAll={() => onOpenTab("activity")} />
    </RecordStack>
  );
}

function RecentActivity({ tokenId, onViewAll }: { tokenId: string; onViewAll: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const { data, error } = useTokenActivity(tokenId, { page: 1, pageSize: 2 });
  const events = data?.events ?? [];

  return (
    <RecordBlock
      title={t("DashboardIssuance.newDesign.overview.recentActivity")}
      aside={
        <Button variant="outline" size="sm" onClick={onViewAll}>
          {t("DashboardIssuance.newDesign.overview.viewAllActivity")}
        </Button>
      }
    >
      {error ? (
        <p className="text-body text-secondary">
          {t("DashboardIssuance.newDesign.activity.loadFailed")}
        </p>
      ) : data && events.length === 0 ? (
        <p className="text-body text-secondary">
          {t("DashboardIssuance.newDesign.activity.empty")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {events.map((event) => {
            const status = activityStatus(event, t);
            const moment = formatTokenMoment(event.createdAt, locale);
            return (
              <li
                key={event.id}
                className="flex items-start justify-between gap-6 border-b border-border-subtle py-3 first:pt-0 last:border-b-0 last:pb-0"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center gap-2 text-body font-medium text-primary">
                    {activityEventLabel(event.action, t)}
                    <StatusText tone={status.tone} className="font-normal">
                      {status.label}
                    </StatusText>
                  </span>
                  <span className="truncate text-meta text-secondary">
                    {event.actorLabel} · {activityActorType(event, t)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-right tabular-nums">
                  <span className="text-body font-medium text-primary">{moment?.day}</span>
                  <span className="text-meta text-tertiary">{moment?.time}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </RecordBlock>
  );
}
