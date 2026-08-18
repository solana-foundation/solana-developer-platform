"use client";

import type {
  OperationFamilyPolicyRule,
  PolicyRule,
  WalletControlProfileRevisionHistory,
  WalletControlProfileRevisionSummary,
} from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { ArrowUpCircle, ChevronRight, ExternalLink, KeyRound } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { resolveTransferTokenLabel } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { JsonCodeBlock } from "@/components/ui/code-block";
import { HeightReveal } from "@/components/ui/height-reveal";
import { UserAvatar } from "@/components/user-avatar";
import { useLocale, useTranslations } from "@/i18n/provider";
import { replaceDashboardSearchParams } from "@/lib/dashboard-url-state";
import { explorerAddressUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn, formatDisplayLabel } from "@/lib/utils";
import { formatPolicyDate, formatPolicyDateTime, shortIdentifier } from "./policy-audit.shared";
import { AUTHORING_RULE_ACTIONS, categoryForRule } from "./wallet-policy-authoring";
import {
  CATEGORY_OPTIONS,
  FAMILY_DESCRIPTION_KEYS,
  FAMILY_LABEL_KEYS,
  RULE_ACTION_LABEL_KEYS,
} from "./wallet-policy-flow.shared";

export function PolicyRevisionExplorer({
  history,
  initialRevisionId,
  userNames = {},
  onRevisionSelect,
  flush = false,
}: {
  history: WalletControlProfileRevisionHistory;
  initialRevisionId?: string;
  userNames?: Record<string, string>;
  onRevisionSelect?: (revisionId: string) => void;
  flush?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [selectedRevisionId, setSelectedRevisionId] = useState(initialRevisionId);

  if (history.revisions.length === 0) {
    return (
      <div className="border-y border-border-default py-16 text-center">
        <p className="text-sm font-medium text-primary">
          {t("DashboardCustody.policyRevisionsEmpty")}
        </p>
        <p className="mt-1 text-sm text-secondary">
          {t("DashboardCustody.policyRevisionsEmptyDescription")}
        </p>
      </div>
    );
  }

  const selected =
    history.revisions.find((revision) => revision.id === selectedRevisionId) ??
    history.revisions[0];

  return (
    <div
      className={cn(
        "grid overflow-hidden bg-surface-raised lg:grid-cols-[320px_minmax(0,1fr)]",
        flush
          ? "h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-1"
          : "rounded-lg border border-border-default"
      )}
    >
      <div
        className={cn(
          "border-b border-border-default lg:border-r lg:border-b-0",
          flush && "flex min-h-0 flex-col"
        )}
      >
        <div className={cn("border-b border-border-default px-4 py-3", flush && "shrink-0")}>
          <p className="text-lg font-medium text-primary">
            {t("DashboardCustody.policyRevisionsChanges")}
          </p>
        </div>
        <div
          className={cn(
            "divide-y divide-border-default",
            flush && "min-h-0 flex-1 overflow-y-auto overscroll-contain"
          )}
        >
          {history.revisions.map((revision) => {
            const isSelected = revision.id === selected.id;
            const creatorName = revision.createdBy
              ? (userNames[revision.createdBy] ?? shortIdentifier(revision.createdBy))
              : t("DashboardCustody.policyRevisionsSystem");

            return (
              <div
                key={revision.id}
                className={cn(
                  "relative px-4 py-4 transition-colors hover:bg-fill-subtle",
                  isSelected && "bg-fill-subtle"
                )}
              >
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => {
                    setSelectedRevisionId(revision.id);
                    replaceDashboardSearchParams({ revision: revision.id });
                    onRevisionSelect?.(revision.id);
                  }}
                  className="absolute inset-0 z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                >
                  <span className="sr-only">
                    {t("DashboardCustody.policyRevisionNumber", {
                      number: revision.revisionNumber,
                    })}
                  </span>
                </button>
                <div className="pointer-events-none">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-primary">
                      {t("DashboardCustody.policyRevisionNumber", {
                        number: revision.revisionNumber,
                      })}
                    </p>
                    <div className="flex items-center gap-2">
                      <RevisionStatusBadge revision={revision} />
                      <time
                        dateTime={revision.createdAt}
                        title={formatPolicyDateTime(revision.createdAt, locale)}
                        className="whitespace-nowrap text-xs text-tertiary"
                      >
                        {formatPolicyDate(revision.createdAt, locale)}
                      </time>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <RevisionCreatorMark createdBy={revision.createdBy} name={creatorName} />
                    {revision.commitMessage ? (
                      <p className="min-w-0 break-words text-sm text-secondary">
                        {revision.commitMessage}
                      </p>
                    ) : (
                      <p className="text-sm italic text-tertiary">
                        {t("DashboardCustody.policyRevisionsNoMessage")}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <RevisionSnapshot
        key={selected.id}
        revision={selected}
        userNames={userNames}
        scroll={flush}
      />
    </div>
  );
}

/**
 * Whether a revision's creator identifier belongs to an API key rather than a
 * dashboard user.
 *
 * @param createdBy - The revision's creator identifier.
 * @returns True when the identifier is an API key id.
 */
function isApiKeyCreator(createdBy: string | null): boolean {
  return createdBy?.startsWith("key_") === true;
}

/**
 * The creator marker for a revision: a key icon labelled "API key" when the
 * revision was committed by an API key, the person initials avatar otherwise.
 *
 * @param props.createdBy - The revision's creator identifier.
 * @param props.name - The creator's display label the avatar derives from.
 * @returns The marker element.
 */
function RevisionCreatorMark({ createdBy, name }: { createdBy: string | null; name: string }) {
  const t = useTranslations();
  if (isApiKeyCreator(createdBy)) {
    return (
      <KeyRound
        role="img"
        aria-label={t("DashboardCustody.policyAuditApiKeyActor")}
        className="size-4 shrink-0 text-secondary"
      />
    );
  }
  return <UserAvatar name={name} />;
}

function RevisionStatusBadge({ revision }: { revision: WalletControlProfileRevisionSummary }) {
  const t = useTranslations();
  if (revision.isActive || revision.activatedAt) return null;
  return <Badge variant="warning">{t("DashboardCustody.policyRevisionsDraft")}</Badge>;
}

function RevisionSnapshot({
  revision,
  userNames,
  scroll,
}: {
  revision: WalletControlProfileRevisionSummary;
  userNames: Record<string, string>;
  scroll: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const creatorName = revision.createdBy
    ? (userNames[revision.createdBy] ?? shortIdentifier(revision.createdBy))
    : t("DashboardCustody.policyRevisionsSystem");

  return (
    <section
      className={cn("min-w-0 p-5 sm:p-6", scroll && "min-h-0 overflow-y-auto overscroll-contain")}
    >
      <div className="border-b border-border-default pr-12 pb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-3xl font-medium tracking-tight text-primary">
            {t("DashboardCustody.policyRevisionNumber", { number: revision.revisionNumber })}
          </h2>
          {revision.isActive ? (
            <span className="inline-flex h-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-primary py-0.5 pr-1.5 pl-2 text-[11px]/[20px] font-medium tracking-[0.2px] text-on-primary">
              <ArrowUpCircle aria-hidden="true" className="-ml-1 size-3 shrink-0" />
              {t("DashboardCustody.policyRevisionsActive")}
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-secondary">
          <time dateTime={revision.createdAt} className="min-w-36">
            {formatPolicyDateTime(revision.createdAt, locale)}
          </time>
          <div className="flex min-w-0 items-center gap-2">
            <RevisionCreatorMark createdBy={revision.createdBy} name={creatorName} />
            {isApiKeyCreator(revision.createdBy) ? (
              <>
                <span className="min-w-0 truncate">
                  {t("DashboardCustody.policyAuditApiKeyActor")}
                </span>
                <span className="shrink-0 text-xs text-tertiary">{creatorName}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">{creatorName}</span>
            )}
            {revision.createdBy ? (
              <WalletMetadataCopyButton
                value={revision.createdBy}
                label={t(
                  isApiKeyCreator(revision.createdBy)
                    ? "DashboardCustody.policyAuditApiKeyId"
                    : "DashboardCustody.policyAuditUserId"
                )}
                tooltip={revision.createdBy}
              />
            ) : null}
          </div>
        </div>
        {revision.commitMessage ? (
          <p className="mt-3 break-words text-sm text-secondary">{revision.commitMessage}</p>
        ) : null}
      </div>

      <div className="pt-5">
        <RevisionRuleRows rules={revision.rules} defaultAction={revision.defaultAction} />
      </div>
    </section>
  );
}

interface RevisionRuleGroup {
  key: string;
  title: string;
  rules: { rule: PolicyRule; index: number }[];
}

/**
 * The snapshot's default action and stored rules, grouped by restriction
 * category so several stored rules of one classification (e.g. two
 * operation-family rules) read as rows of a single section, the way the
 * authoring editor presents them.
 *
 * @param props.rules - The revision's rule snapshot.
 * @param props.defaultAction - Action a rule falls back to when it declares none.
 * @returns The default action followed by one card per rule category, each with a single raw-data disclosure.
 */
function RevisionRuleRows({
  rules,
  defaultAction,
}: {
  rules: PolicyRule[];
  defaultAction: string;
}) {
  const t = useTranslations();
  const groups: RevisionRuleGroup[] = [];
  const groupByKey = new Map<string, RevisionRuleGroup>();
  rules.forEach((rule, index) => {
    const categoryOption = CATEGORY_OPTIONS.find((option) => option.id === categoryForRule(rule));
    const key = categoryOption?.id ?? rule.id ?? `${rule.kind}-${index}`;
    const existing = groupByKey.get(key);
    if (existing) {
      existing.rules.push({ rule, index });
      return;
    }
    const group: RevisionRuleGroup = {
      key,
      title: categoryOption
        ? t(categoryOption.titleKey)
        : (rule.name ?? formatDisplayLabel(rule.kind)),
      rules: [{ rule, index }],
    };
    groupByKey.set(key, group);
    groups.push(group);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
        <p className="text-base font-medium text-primary">
          {t("DashboardCustody.policyRevisionsDefaultAction")}
        </p>
        <PolicyActionOptions action={defaultAction} />
      </div>
      {rules.length === 0 ? (
        <p className="text-sm text-secondary">{t("DashboardCustody.policyRevisionsNoRules")}</p>
      ) : (
        groups.map((group) => (
          <div
            key={group.key}
            className="relative rounded-lg border border-border-subtle bg-surface-sunken p-4"
          >
            <p className="pr-32 text-base font-medium text-primary">{group.title}</p>
            <div className="divide-y divide-border-subtle">
              {group.rules.map(({ rule, index }) => (
                <div key={rule.id ?? `${rule.kind}-${index}`} className="py-3 last:pb-0">
                  {rule.kind === "operation_family" ? (
                    <OperationFamilyRuleSummary rule={rule} defaultAction={defaultAction} />
                  ) : (
                    <RuleSummary rule={rule} />
                  )}
                </div>
              ))}
            </div>
            <RawDataDetails
              value={
                group.rules.length === 1 ? group.rules[0].rule : group.rules.map(({ rule }) => rule)
              }
              label={t("DashboardCustody.policyRevisionsRawRule")}
              filename={`${
                group.rules.length === 1 ? (group.rules[0].rule.id ?? group.key) : group.key
              }.json`}
            />
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Editor-style rows for an operation-family rule: each covered family shows
 * the shared family label and description with the rule's decision rendered
 * as the same read-only action options the default-action row uses.
 *
 * @param props.rule - The stored operation-family rule.
 * @param props.defaultAction - Revision default applied when the rule declares no action.
 * @returns One labeled row per family the rule covers.
 */
function OperationFamilyRuleSummary({
  rule,
  defaultAction,
}: {
  rule: OperationFamilyPolicyRule;
  defaultAction: string;
}) {
  const t = useTranslations();
  const families = rule.families ?? (rule.family ? [rule.family] : []);

  return (
    <div className="space-y-3">
      {rule.description ? (
        <p className="text-sm leading-5 text-secondary">{rule.description}</p>
      ) : null}
      {families.map((family) => (
        <div key={family} className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-primary">{t(FAMILY_LABEL_KEYS[family])}</p>
            <p className="mt-0.5 text-xs text-muted">{t(FAMILY_DESCRIPTION_KEYS[family])}</p>
          </div>
          <PolicyActionOptions action={rule.action ?? defaultAction} />
        </div>
      ))}
    </div>
  );
}

function PolicyActionOptions({ action }: { action: string }) {
  const t = useTranslations();
  const activeAction = action === "review" ? "approval_required" : action;

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg bg-fill p-1">
      {AUTHORING_RULE_ACTIONS.map((option) => (
        <span
          key={option}
          aria-current={option === activeAction ? "true" : undefined}
          aria-disabled={option !== activeAction}
          className={cn(
            "select-none rounded-md px-2 py-1 text-xs font-medium",
            option === activeAction
              ? "bg-primary text-on-primary"
              : "cursor-not-allowed text-muted opacity-40 grayscale"
          )}
        >
          {t(RULE_ACTION_LABEL_KEYS[option])}
        </span>
      ))}
    </div>
  );
}

function RuleSummary({ rule }: { rule: PolicyRule }) {
  const hiddenKeys = new Set(["id", "name", "kind", "action", "description"]);
  const entries = Object.entries(rule).filter(
    ([key, value]) => !hiddenKeys.has(key) && value !== null && value !== undefined && value !== ""
  );

  return (
    <div>
      {rule.description ? (
        <p className="text-sm leading-5 text-secondary">{rule.description}</p>
      ) : null}
      {entries.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map(([key, value]) => (
            <div
              key={key}
              className={cn(
                "min-w-0",
                (key === "assets" || rule.kind === "destination") && "sm:col-span-2 xl:col-span-3"
              )}
            >
              <dt className="text-xs text-tertiary">{formatDisplayLabel(key)}</dt>
              <dd className="mt-1 break-words text-sm text-primary">
                <RuleValue field={key} value={value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function RawDataDetails({
  value,
  label,
  filename,
}: {
  value: unknown;
  label: string;
  filename: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="absolute top-4 right-4 w-fit cursor-pointer text-xs text-secondary transition-colors hover:text-primary"
      >
        {label}
        <ChevronRight
          className={cn("ml-1 inline size-3 transition-transform", open && "rotate-90")}
        />
      </button>
      <AnimatePresence>
        {open ? (
          <HeightReveal key="raw-rule-data">
            <div className="p-px pt-3">
              <JsonCodeBlock value={value} title={filename} viewportClassName="max-h-96" />
            </div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function RuleValue({ field, value }: { field: string; value: unknown }) {
  const cluster = useSolanaCluster();

  if (["allowlist", "blocklist", "destination", "destinations"].includes(field)) {
    const addresses = Array.isArray(value) ? value : [value];

    return (
      <ul className="space-y-1.5">
        {addresses.map((address) => {
          const addressText = String(address);

          return (
            <li key={addressText}>
              <a
                href={explorerAddressUrl(addressText, cluster)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1 underline underline-offset-2"
              >
                <span className="break-all">{addressText}</span>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              </a>
            </li>
          );
        })}
      </ul>
    );
  }

  if (field === "assets" && Array.isArray(value)) {
    return (
      <ul className="grid gap-2 sm:grid-cols-2">
        {value.map((asset) => {
          const mint = String(asset);
          const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
          const symbol = resolveTransferTokenLabel(mint) ?? mint;

          return (
            <li
              key={mint}
              className="flex min-w-0 items-center gap-2 rounded-md bg-surface-raised p-2"
            >
              <TokenMark mint={mint} symbol={symbol} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm text-primary" title={knownToken?.name ?? symbol}>
                  {knownToken?.name ?? symbol}
                </p>
                <p className="truncate text-xs text-tertiary" title={mint}>
                  {knownToken ? `${knownToken.symbol} · ${shortIdentifier(mint)}` : mint}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return formatRuleValue(value);
}

function formatRuleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
