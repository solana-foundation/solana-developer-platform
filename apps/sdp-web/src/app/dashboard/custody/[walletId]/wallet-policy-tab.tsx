"use client";

import type {
  PaymentWalletPolicy,
  PaymentWalletPolicyAuditEntry,
  PolicyDecision,
} from "@sdp/types";
import { PauseIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { RecordBlock, RecordRow, RecordStack, StateBand } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { resolveTransferTokenLabel } from "../../payments/payments-overview.utils";
import { formatDate } from "../../payments/payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../../payments/payments-table";
import { DisableControlsDialog } from "./policy/disable-controls-dialog";
import { decisionLabel, shortIdentifier } from "./policy/policy-audit.shared";
import { buildDisabledPolicyPayload } from "./policy/wallet-policy-authoring";
import {
  type IssuedTokensByMint,
  POLICY_DATE,
  policyRestricts,
  policyRulesView,
  symbolsByMint,
  type WalletBalancesResult,
  type WalletPageView,
  type WalletPolicyResult,
  type WalletRevisionsResult,
  walletPolicyHref,
} from "./wallet-detail.shared";

const DECISION_TONE: Record<PolicyDecision, StatusTone> = {
  allow: "positive",
  deny: "neutral",
  approval_required: "attention",
  provider_approval_required: "attention",
  review: "attention",
  not_evaluated: "neutral",
};

function familyName(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1).replace(/_/g, " ");
}

/** The policy's state, what it means, and the way into the editor. */
function PolicyBand({ walletId, policy }: { walletId: string; policy: PaymentWalletPolicy }) {
  const t = useTranslations();
  const locale = useLocale();
  const profile = policy.controlProfile;
  const editLink = (label: string) => (
    <Button asChild variant="outline" size="sm">
      <Link href={walletPolicyHref(walletId)}>{label}</Link>
    </Button>
  );
  if (!profile || !policyRestricts(policy)) {
    return (
      <StateBand
        tone="neutral"
        state={t("DashboardCustody.walletPolicyStateNone")}
        action={editLink(t("DashboardCustody.walletSetUpPolicy"))}
      >
        {t("DashboardCustody.walletPolicyStateNoneBody")}
      </StateBand>
    );
  }
  if (profile.status === "active") {
    const date = profile.activatedAt
      ? new Intl.DateTimeFormat(locale, POLICY_DATE).format(new Date(profile.activatedAt))
      : null;
    return (
      <StateBand
        tone="ok"
        state={t("DashboardCustody.walletStateActive")}
        action={editLink(t("DashboardCustody.walletEditPolicy"))}
      >
        {profile.revisionNumber && date
          ? t("DashboardCustody.walletPolicyStateActiveBody", {
              number: profile.revisionNumber,
              date,
            })
          : null}
      </StateBand>
    );
  }
  return (
    <StateBand
      tone="neutral"
      state={
        profile.status === "draft"
          ? t("DashboardCustody.walletPolicyStateDraft")
          : t("DashboardCustody.walletPolicyStateDisabled")
      }
      action={editLink(t("DashboardCustody.walletEditPolicy"))}
    >
      {profile.status === "draft"
        ? t("DashboardCustody.walletPolicyStateDraftBody")
        : t("DashboardCustody.walletPolicyStateDisabledBody")}
    </StateBand>
  );
}

function RulesBlock({
  policy,
  symbols,
}: {
  policy: PaymentWalletPolicy;
  symbols: Record<string, string>;
}) {
  const t = useTranslations();
  const rules = policyRulesView(policy, symbols, t);
  return (
    <RecordBlock title={t("DashboardCustody.walletRules")}>
      <dl>
        <RecordRow label={t("DashboardCustody.policyRevisionsDefaultAction")}>
          <StatusText tone={rules.defaultAction.tone}>{rules.defaultAction.label}</StatusText>
        </RecordRow>
        <RecordRow label={t("DashboardCustody.perTransfer")}>{rules.perTransfer}</RecordRow>
        <RecordRow label={t("DashboardCustody.walletAllowedTokens")}>
          {rules.allowedTokens}
        </RecordRow>
        <RecordRow label={t("DashboardCustody.destinations")}>{rules.destinations}</RecordRow>
        <RecordRow label={t("DashboardCustody.walletOperations")}>{rules.operations}</RecordRow>
      </dl>
    </RecordBlock>
  );
}

function RevisionsBlock({ result }: { result: WalletRevisionsResult }) {
  const t = useTranslations();
  const locale = useLocale();
  const revisions = result.history?.revisions ?? [];
  if (result.error) {
    return (
      <RecordBlock title={t("DashboardCustody.policyAuditRevisions")}>
        <p className="text-body text-tertiary">{result.error}</p>
      </RecordBlock>
    );
  }
  if (revisions.length === 0) return null;
  return (
    <RecordBlock title={t("DashboardCustody.policyAuditRevisions")}>
      <div className="overflow-x-auto refresh:-mx-3">
        <Table
          className="min-w-[640px] rounded-none border-0 [&_table]:table-fixed"
          data-wallet-revisions
        >
          <TableHeader>
            <TableRow>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[18%]")}>
                {t("DashboardCustody.policyRevision")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[20%]")}>
                {t("DashboardCustody.walletActivated")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[22%]")}>
                {t("DashboardCustody.walletRevisionBy")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[40%]")}>
                {t("DashboardCustody.walletRevisionMessage")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {revisions.map((revision) => (
              <TableRow key={revision.id}>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="flex items-center gap-2 font-medium text-primary">
                    #{revision.revisionNumber}
                    {revision.isActive ? (
                      <StatusText tone="positive" className="font-normal">
                        {t("DashboardCustody.policyRevisionsActive")}
                      </StatusText>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-primary tabular-nums")}>
                  {formatDate(revision.activatedAt ?? revision.createdAt, locale) ?? "—"}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "truncate text-primary")}>
                  {revision.createdBy
                    ? (result.userNames[revision.createdBy] ?? shortIdentifier(revision.createdBy))
                    : t("DashboardCustody.policyRevisionsSystem")}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "truncate")}>
                  {revision.commitMessage ? (
                    <span className="text-primary" title={revision.commitMessage}>
                      {revision.commitMessage}
                    </span>
                  ) : (
                    <span className="text-tertiary">{t("DashboardCustody.walletNoMessage")}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </RecordBlock>
  );
}

function DecisionsBlock({
  walletId,
  evaluations,
  symbols,
}: {
  walletId: string;
  evaluations: PaymentWalletPolicyAuditEntry[];
  symbols: Record<string, string>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (evaluations.length === 0) return null;
  return (
    <RecordBlock
      title={t("DashboardCustody.walletDecisions")}
      aside={
        <Button asChild variant="outline" size="sm">
          <Link href={walletPolicyHref(walletId, "/audit")}>
            {t("DashboardCustody.walletOpenPolicyDecisions")}
          </Link>
        </Button>
      }
    >
      <div className="overflow-x-auto refresh:-mx-3">
        <Table
          className="min-w-[640px] rounded-none border-0 [&_table]:table-fixed"
          data-wallet-decisions
        >
          <TableHeader>
            <TableRow>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[34%]")}>
                {t("DashboardCustody.walletOperation")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[22%]")}>
                {t("DashboardCustody.policyAuditDecision")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[24%] text-right")}>
                {t("DashboardCustody.walletAmount")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[20%]")}>
                {t("DashboardCustody.policyAuditEvaluated")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evaluations.map((evaluation) => (
              <TableRow key={evaluation.policyEvaluationId}>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="block truncate font-medium text-primary">
                    {familyName(evaluation.operationFamily)}
                  </span>
                  <span className="block truncate text-tertiary">{evaluation.operationType}</span>
                </TableCell>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <StatusText tone={DECISION_TONE[evaluation.decision]}>
                    {decisionLabel(evaluation.decision, t)}
                  </StatusText>
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    "truncate text-right text-primary tabular-nums"
                  )}
                >
                  {evaluation.amount ? (
                    `${evaluation.amount}${
                      evaluation.asset
                        ? ` ${resolveTransferTokenLabel(evaluation.asset, symbols)}`
                        : ""
                    }`
                  ) : (
                    <span className="text-tertiary">{t("DashboardCustody.walletNoAmount")}</span>
                  )}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-primary tabular-nums")}>
                  {formatDate(evaluation.evaluatedAt, locale) ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </RecordBlock>
  );
}

/** Turning the policy off, confirmed first: the wallet goes back to what its provider allows. */
function DisableBlock({ wallet, policy }: { wallet: WalletPageView; policy: PaymentWalletPolicy }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function disable() {
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardCustody.policyDisabling"), {
      position: "bottom-right",
    });
    try {
      await updateWalletPolicy(
        wallet.walletId,
        buildDisabledPolicyPayload(wallet.walletId),
        t,
        undefined,
        {
          expectedRevisionId: policy.controlProfile?.revisionId ?? null,
        }
      );
      setOpen(false);
      toast.success(t("DashboardCustody.policyDisabled"), {
        id: toastId,
        description: t("DashboardCustody.policyDisabledDescription"),
        position: "bottom-right",
      });
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardCustody.policyDisableFailed"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardCustody.policySaveFailed"),
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RecordBlock title={t("DashboardCustody.walletDisablePolicyTitle")}>
      <div className="flex">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className="border-error-border text-error hover:bg-error-bg hover:text-error refresh:border-error-border refresh:hover:bg-error-bg"
          iconLeft={<PauseIcon className="size-4" aria-hidden="true" />}
        >
          {t("DashboardCustody.walletDisablePolicy")}
        </Button>
      </div>
      <DisableControlsDialog
        open={open}
        walletName={wallet.name}
        submitting={submitting}
        onClose={() => setOpen(false)}
        onConfirm={() => void disable()}
      />
    </RecordBlock>
  );
}

/**
 * The wallet's policy: whether one is enforcing and since when, the rules it holds, the
 * revisions it has been through, the latest decisions it made, and turning it off.
 */
export function WalletPolicyTab({
  wallet,
  policyPromise,
  revisionsPromise,
  balancesPromise,
  issuedTokensPromise,
}: {
  wallet: WalletPageView;
  policyPromise: Promise<WalletPolicyResult>;
  revisionsPromise: Promise<WalletRevisionsResult>;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const { policy, error } = use(policyPromise);
  const revisions = use(revisionsPromise);
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const symbols = useMemo(() => symbolsByMint(balances, issued), [balances, issued]);

  if (error || !policy) {
    return <p className="text-body text-tertiary">{error}</p>;
  }
  const active = policy.controlProfile?.status === "active" && policyRestricts(policy);
  return (
    <RecordStack>
      <PolicyBand walletId={wallet.walletId} policy={policy} />
      {policy.controlProfile ? <RulesBlock policy={policy} symbols={symbols} /> : null}
      <RevisionsBlock result={revisions} />
      <DecisionsBlock
        walletId={wallet.walletId}
        evaluations={policy.audit?.recentEvaluations ?? []}
        symbols={symbols}
      />
      {active && wallet.canManageCustody ? <DisableBlock wallet={wallet} policy={policy} /> : null}
    </RecordStack>
  );
}
