"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { RecordAmount } from "@/app/dashboard/payments/payments-record";
import {
  RecordBlock,
  RecordColumns,
  RecordRow,
  RecordStack,
  type StateBandTone,
} from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusText } from "@/components/ui/status-text";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
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
import { deployNetworkName } from "../token-management-workspace.utils";
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

/**
 * The state band's tint and word colour as the token page draws it: a rounded tint with no
 * rule at its start (a plain tile when neutral).
 */
const BAND_TINT: Record<StateBandTone, { band: string; word: string }> = {
  ok: { band: "bg-success/7 dark:bg-success/12", word: "text-success" },
  warn: { band: "bg-warning/7 dark:bg-warning/12", word: "text-warning" },
  error: { band: "bg-error/7 dark:bg-error/12", word: "text-error" },
  info: { band: "bg-info/7 dark:bg-info/12", word: "text-info" },
  neutral: { band: "bg-surface-tile", word: "text-secondary" },
};

/**
 * A section's last row with no padding under it, so the 64px to the next section is measured
 * from its text, as the design spaces them.
 */
const LAST_ROW_FLUSH = "[&>div:last-child]:min-h-0 [&>div:last-child]:pb-0";
/** The same in two columns only: stacked on a phone, a column's last row sits over a rule. */
const LAST_ROW_FLUSH_COLUMNS = "md:[&>div:last-child]:min-h-0 md:[&>div:last-child]:pb-0";

type Translate = ReturnType<typeof useTranslations>;

type OverviewTabProps = TokenTabProps & {
  latestDeploy: LatestDeployAttempt | null;
  onOpenTab: (tab: TokenTab) => void;
};

/** The signing wallet's name, its short address when unnamed, "Not set" when there is none. */
function signingWalletNameOf(
  { token, ops, form }: Pick<TokenTabProps, "token" | "ops" | "form">,
  t: Translate
): string {
  const signingWalletId = token.signingCustodyWalletId ?? form.draft.signingWalletId;
  const signingWallet = ops.authorityWallets.find((wallet) => wallet.id === signingWalletId);
  return (
    signingWallet?.label?.trim() ||
    (signingWallet
      ? shortAddress(signingWallet.publicKey)
      : t("DashboardIssuance.newDesign.notSet"))
  );
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
}: OverviewTabProps) {
  const t = useTranslations();
  const signingWalletName = signingWalletNameOf({ token, ops, form }, t);
  const deployProps = { ops, form, canManageTokenAdmin };

  return (
    <RecordStack>
      {/* The state band sits 24px over what follows it, closer than the parts below. */}
      <div className="flex flex-col gap-6">
        <OverviewStateBand
          onOpenTab={onOpenTab}
          state={state}
          ops={ops}
          latestDeploy={latestDeploy}
          canManageTokenAdmin={canManageTokenAdmin}
        />

        {state === "draft" ? (
          <DeployDraftBlock signingWalletName={signingWalletName} {...deployProps} />
        ) : null}

        {state === "deploying" ? (
          <DeployProgressBlock signingWalletName={signingWalletName} />
        ) : null}

        {state === "failed" ? (
          <DeployFailedBlock state={state} latestDeploy={latestDeploy} {...deployProps} />
        ) : null}

        {state === "paused" && canManageTokenAdmin ? <ResumeTransfersBlock ops={ops} /> : null}

        <SupplyBlock token={token} assetProfile={assetProfile} ops={ops} />
      </div>

      <IdentityBlock
        token={token}
        ops={ops}
        form={form}
        state={state}
        signingWalletName={signingWalletName}
      />

      <RecentActivity tokenId={token.id} onViewAll={() => onOpenTab("activity")} />
    </RecordStack>
  );
}

/**
 * The token's state, why it is there, and its one action: minting, or how long a deploy has
 * run, counting at the band's top end.
 */
function OverviewStateBand({
  state,
  ops,
  latestDeploy,
  canManageTokenAdmin,
  onOpenTab,
}: Pick<OverviewTabProps, "state" | "ops" | "latestDeploy" | "canManageTokenAdmin" | "onOpenTab">) {
  const t = useTranslations();
  const tint = BAND_TINT[TOKEN_LIFECYCLE_BAND[state]];
  const mintBlocked = ops.operationAvailability.mint ?? null;
  const action =
    state === "live" && canManageTokenAdmin ? (
      <TokenDisabledActionTooltip reason={mintBlocked}>
        <Button
          size="sm"
          className="[--button-height-md:1.875rem]"
          disabled={ops.isPending || Boolean(mintBlocked)}
          onClick={() => {
            // Minting opens in place on Operations, under the issued supply.
            ops.openFundManagementModal("mint");
            onOpenTab("operations");
          }}
        >
          {t("DashboardIssuance.newDesign.overview.mintTokens")}
        </Button>
      </TokenDisabledActionTooltip>
    ) : state === "deploying" && latestDeploy ? (
      <DeployElapsed since={latestDeploy.createdAt} />
    ) : null;
  const deploying = state === "deploying";

  return (
    <div
      data-state-band={TOKEN_LIFECYCLE_BAND[state]}
      className={cn(
        "flex flex-col items-start gap-3 rounded-card px-5 py-3 md:flex-row md:justify-between md:gap-6",
        deploying ? "md:items-start" : "md:items-center",
        tint.band
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:flex-1">
        <p className={cn("text-body font-medium", tint.word)}>{t(TOKEN_LIFECYCLE_LABEL[state])}</p>
        <p className={cn("text-body text-secondary", deploying ? "max-w-md" : "max-w-[40em]")}>
          {t(TOKEN_LIFECYCLE_WHY[state])}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** How long the deploy has run, ticking: tenths of a second under a minute, then whole seconds. */
function DeployElapsed({ since }: { since: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const elapsed = Math.max(0, now - new Date(since).getTime());
  const underMinute = elapsed < 60_000;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), underMinute ? 100 : 1_000);
    return () => window.clearInterval(timer);
  }, [underMinute]);
  const seconds = Math.floor(elapsed / 1_000);
  return (
    // The server renders its own moment; the browser's clock takes over at once.
    <span suppressHydrationWarning className="text-body text-secondary tabular-nums">
      {underMinute
        ? t("DashboardIssuance.newDesign.overview.elapsedSeconds", {
            seconds: new Intl.NumberFormat(locale, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }).format(Math.floor(elapsed / 100) / 10),
          })
        : t("DashboardIssuance.newDesign.overview.elapsedMinutes", {
            minutes: Math.floor(seconds / 60),
            seconds: seconds % 60,
          })}
    </span>
  );
}

/**
 * A deploy in flight, as the design walks it: signing with the token's wallet, sending to the
 * network, confirming the mint. The API signs, sends and confirms in one request, and its deploy
 * transaction stays pending until it lands: confirmed (the token goes live and this block gives
 * way) or failed. Nothing in between tells the steps apart, so while the block shows every step
 * is under way rather than one standing still at signing.
 */
export function DeployProgressBlock({ signingWalletName }: { signingWalletName: string }) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const network = deployNetworkName(sdpEnvironment, t);
  const steps = [
    t("DashboardIssuance.newDesign.overview.deployStepSign", { wallet: signingWalletName }),
    t("DashboardIssuance.newDesign.overview.deployStepSend", { network }),
    t("DashboardIssuance.newDesign.overview.deployStepConfirm"),
  ];
  // 24px from the heading to the steps, each a 40px row over a rule; 32px under the last to the
  // supply, as the draft's deploy block leaves.
  return (
    <section data-deploy-progress className="mb-2 flex min-w-0 flex-col gap-6">
      <h2 className="text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.overview.deployTitle")}
      </h2>
      <ol>
        {steps.map((label) => (
          <li
            key={label}
            className="flex min-h-10 items-center gap-4.5 border-b border-border-subtle ps-1 last:border-b-0"
          >
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-info" />
            <span className="text-nav text-primary">{label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type DeployProps = Pick<OverviewTabProps, "ops" | "form" | "canManageTokenAdmin">;

/** Deploys the draft with its saved authorities, held back while edits are unsaved. */
function DeployButton({ label, ops, form, canManageTokenAdmin }: DeployProps & { label: string }) {
  const t = useTranslations();
  const deployBlocked = form.dirty
    ? t("DashboardIssuance.simplified.saveBeforeDeploy")
    : (form.errors.authorityWalletIds ?? ops.deployDisabledReason);
  const deploy = () =>
    ops.deployToken({
      ...form.draft.authorityWalletIds,
      "mint-authority": form.draft.signingWalletId,
    });

  return (
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
}

/** A draft's one ask: what deploying signs with and holds, and the deploy itself. */
function DeployDraftBlock({
  signingWalletName,
  ...deployProps
}: DeployProps & { signingWalletName: string }) {
  const t = useTranslations();
  // 12px from the heading to the rows and 10px from the rows to the 34px buttons; 32px under
  // the buttons to the supply, 8px more than the band's 24 over this block. A phone's buttons
  // are the full 36px, 16px under the rows.
  return (
    <section className="mb-2 flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-1.5 text-subheading font-medium text-primary">
        {t("DashboardIssuance.newDesign.overview.deployTitle")}
        <InfoHint text={t("DashboardIssuance.newDesign.overview.deployBody")} />
      </h2>
      <dl>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.signingWallet")}>
          {signingWalletName}
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.authorities")}>
          <span className="max-w-[32em] whitespace-normal">
            {t("DashboardIssuance.newDesign.overview.authoritiesDraft")}
          </span>
        </RecordRow>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.reversible")}>
          <span className="max-w-[32em] whitespace-normal">
            {t("DashboardIssuance.newDesign.overview.reversibleNo")}
          </span>
        </RecordRow>
      </dl>
      <div className="mt-1 flex items-center justify-end gap-2 md:-mt-0.5 md:[&_a]:[--button-height-md:2.125rem] md:[&_button]:[--button-height-md:2.125rem]">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/issuance">{t("DashboardIssuance.newDesign.overview.notNow")}</Link>
        </Button>
        <DeployButton
          label={t("DashboardIssuance.newDesign.overview.deployToken")}
          {...deployProps}
        />
      </div>
    </section>
  );
}

/** A failed deploy: why it failed, a retry, and the way to the wallets that sign it. */
function DeployFailedBlock({
  state,
  latestDeploy,
  ...deployProps
}: DeployProps & Pick<OverviewTabProps, "state" | "latestDeploy">) {
  const t = useTranslations();
  const failedWhy =
    state === "failed" && latestDeploy?.error ? latestDeploy.error : t(TOKEN_LIFECYCLE_WHY[state]);
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="max-w-[40em] text-body text-secondary">{failedWhy}</p>
      <div className="flex items-center gap-2">
        <DeployButton
          label={t("DashboardIssuance.newDesign.overview.retryDeploy")}
          {...deployProps}
        />
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/wallets">
            {t("DashboardIssuance.newDesign.overview.openWallets")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** A paused token's one ask: resuming its transfers. */
function ResumeTransfersBlock({ ops }: Pick<TokenTabProps, "ops">) {
  const t = useTranslations();
  return (
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
  );
}

/** The issued supply over the token's terms and classification. */
function SupplyBlock({
  token,
  assetProfile,
  ops,
}: Pick<TokenTabProps, "token" | "assetProfile" | "ops">) {
  const t = useTranslations();
  const locale = useLocale();
  const classification = classificationOf(assetProfile, t);
  return (
    <RecordBlock className="gap-0">
      <RecordAmount label={t("DashboardIssuance.newDesign.overview.issuedSupply")}>
        {formatDecimalAmount(token.totalSupply || "0", locale)}
      </RecordAmount>
      {/* 26px from the amount to its terms (22 on a phone, whose rows start 2px lower), 8px from
          the terms to the description. */}
      <div className="mt-5.5 mb-2 md:mt-6.5">
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
              <RecordRow
                label={t("DashboardIssuance.newDesign.overview.type")}
                hint={t("DashboardIssuance.newDesign.overview.typeHelp")}
              >
                {classification.type}
              </RecordRow>
            ) : null}
            <RecordRow label={t("DashboardIssuance.newDesign.overview.accessControl")}>
              {accessControlLabel(ops.accessControlMode, t)}
            </RecordRow>
          </dl>
        </RecordColumns>
      </div>
      <dl className={cn("border-t border-border-subtle", LAST_ROW_FLUSH)}>
        <RecordRow label={t("DashboardIssuance.newDesign.overview.description")}>
          <span className="max-w-[40em] whitespace-normal md:text-right">
            {token.description || t("DashboardIssuance.newDesign.overview.noDescription")}
          </span>
        </RecordRow>
      </dl>
    </RecordBlock>
  );
}

/** Who and what the token is: its addresses, authorities, issuer, signer and age. */
function IdentityBlock({
  token,
  ops,
  form,
  state,
  signingWalletName,
}: Pick<TokenTabProps, "token" | "ops" | "form" | "state"> & { signingWalletName: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const onChain = isOnChain(state);
  const heldAuthorities = ops.permissionRows.filter((row) => row.value || !onChain);
  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.overview.identity")} className="gap-3">
      <RecordColumns>
        <dl className={LAST_ROW_FLUSH_COLUMNS}>
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
        <dl className={LAST_ROW_FLUSH_COLUMNS}>
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
                    {activityEventLabel(event.action, t, event.resourceType)}
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
