import type {
  PolicyRule,
  WalletControlProfileRevisionHistory,
  WalletControlProfileRevisionSummary,
} from "@sdp/types";
import { Braces, ChevronRight, Clock3, ShieldCheck, UserRound } from "lucide-react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
import { formatDisplayLabel } from "@/lib/utils";
import { formatPolicyDateTime, type PolicyTranslate, shortIdentifier } from "./policy-audit.shared";

export function PolicyRevisionExplorer({
  history,
  selectedRevisionId,
  baseHref,
  searchParams,
  locale,
  t,
}: {
  history: WalletControlProfileRevisionHistory;
  selectedRevisionId?: string;
  baseHref: string;
  searchParams?: URLSearchParams;
  locale: string;
  t: PolicyTranslate;
}) {
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
    <div className="grid overflow-hidden rounded-lg border border-border-default bg-surface-raised lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="border-b border-border-default lg:border-r lg:border-b-0">
        <div className="border-b border-border-default bg-fill-subtle px-4 py-3">
          <p className="text-xs font-medium text-secondary">
            {t("DashboardCustody.policyRevisionsNewestFirst")}
          </p>
        </div>
        <div className="divide-y divide-border-default">
          {history.revisions.map((revision) => {
            const isSelected = revision.id === selected.id;

            return (
              <Link
                key={revision.id}
                href={revisionHref(baseHref, searchParams, revision.id)}
                aria-current={isSelected ? "page" : undefined}
                className={`block px-4 py-4 transition-colors hover:bg-fill-subtle focus-visible:outline-2 ${
                  isSelected ? "bg-fill-subtle" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-primary">
                    {t("DashboardCustody.policyRevisionNumber", {
                      number: revision.revisionNumber,
                    })}
                  </p>
                  <RevisionStatusBadge revision={revision} t={t} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <RevisionListValue
                    label={t("DashboardCustody.policyRevisionsCreated")}
                    value={formatPolicyDateTime(revision.createdAt, locale)}
                  />
                  <RevisionListValue
                    label={t("DashboardCustody.policyRevisionsActivated")}
                    value={
                      revision.activatedAt
                        ? formatPolicyDateTime(revision.activatedAt, locale)
                        : "-"
                    }
                  />
                  <RevisionListValue
                    label={t("DashboardCustody.policyRevisionsRules")}
                    value={String(revision.rules.length)}
                  />
                  <RevisionListValue
                    label={t("DashboardCustody.policyRevisionsCreator")}
                    value={
                      revision.createdBy
                        ? shortIdentifier(revision.createdBy)
                        : t("DashboardCustody.policyRevisionsSystem")
                    }
                  />
                </dl>
              </Link>
            );
          })}
        </div>
      </div>

      <RevisionSnapshot revision={selected} locale={locale} t={t} />
    </div>
  );
}

function revisionHref(
  baseHref: string,
  searchParams: URLSearchParams | undefined,
  revisionId: string
): string {
  const query = new URLSearchParams(searchParams);
  query.set("revision", revisionId);
  return `${baseHref}?${query}`;
}

function RevisionStatusBadge({
  revision,
  t,
}: {
  revision: WalletControlProfileRevisionSummary;
  t: PolicyTranslate;
}) {
  if (revision.isActive) {
    return <Badge variant="success">{t("DashboardCustody.policyRevisionsActive")}</Badge>;
  }
  if (revision.activatedAt) {
    return <Badge>{t("DashboardCustody.policyRevisionsHistorical")}</Badge>;
  }
  return <Badge variant="warning">{t("DashboardCustody.policyRevisionsDraft")}</Badge>;
}

function RevisionListValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-tertiary">{label}</dt>
      <dd className="mt-0.5 truncate text-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

function RevisionSnapshot({
  revision,
  locale,
  t,
}: {
  revision: WalletControlProfileRevisionSummary;
  locale: string;
  t: PolicyTranslate;
}) {
  return (
    <section className="min-w-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-default pb-5">
        <div>
          <p className="text-xs font-medium text-secondary">
            {t("DashboardCustody.policyRevisionsRuleSnapshot")}
          </p>
          <h2 className="mt-1 text-xl font-medium text-primary">
            {t("DashboardCustody.policyRevisionNumber", { number: revision.revisionNumber })}
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {t("DashboardCustody.policyRevisionsSnapshotDescription")}
          </p>
        </div>
        <RevisionStatusBadge revision={revision} t={t} />
      </div>

      <dl className="grid gap-4 border-b border-border-default py-5 sm:grid-cols-2 xl:grid-cols-4">
        <SnapshotValue
          icon={<ShieldCheck className="size-4" />}
          label={t("DashboardCustody.policyRevisionsDefaultAction")}
          value={formatDisplayLabel(revision.defaultAction)}
        />
        <SnapshotValue
          icon={<Braces className="size-4" />}
          label={t("DashboardCustody.policyRevisionsRules")}
          value={String(revision.rules.length)}
        />
        <SnapshotValue
          icon={<Clock3 className="size-4" />}
          label={t("DashboardCustody.policyRevisionsCreated")}
          value={formatPolicyDateTime(revision.createdAt, locale)}
        />
        <SnapshotValue
          icon={<UserRound className="size-4" />}
          label={t("DashboardCustody.policyRevisionsCreator")}
          value={revision.createdBy ?? t("DashboardCustody.policyRevisionsSystem")}
        />
      </dl>

      <div className="pt-5">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardCustody.policyRevisionsRules")}
        </h3>
        {revision.rules.length === 0 ? (
          <p className="mt-3 border-y border-border-default py-8 text-sm text-secondary">
            {t("DashboardCustody.policyRevisionsNoRules")}
          </p>
        ) : (
          <div className="mt-3 divide-y divide-border-default border-y border-border-default">
            {revision.rules.map((rule, index) => (
              <div key={rule.id ?? `${rule.kind}-${index}`} className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-primary">
                      {rule.name ?? formatDisplayLabel(rule.kind)}
                    </p>
                    <p className="mt-1 text-xs text-secondary">
                      {t("DashboardCustody.policyRevisionsRuleNumber", { number: index + 1 })}
                    </p>
                  </div>
                  <Badge>{formatDisplayLabel(rule.action ?? revision.defaultAction)}</Badge>
                </div>
                <RuleSummary rule={rule} t={t} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RuleSummary({ rule, t }: { rule: PolicyRule; t: PolicyTranslate }) {
  const hiddenKeys = new Set(["id", "name", "kind", "action", "description"]);
  const entries = Object.entries(rule).filter(
    ([key, value]) => !hiddenKeys.has(key) && value !== null && value !== undefined && value !== ""
  );

  return (
    <div className="mt-3">
      {rule.description ? (
        <p className="text-sm leading-5 text-secondary">{rule.description}</p>
      ) : null}
      {entries.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-tertiary">{formatDisplayLabel(key)}</dt>
              <dd className="mt-1 break-words text-sm text-primary">{formatRuleValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="group/rule mt-3">
        <summary className="w-fit cursor-pointer list-none text-xs text-secondary transition-colors hover:text-primary">
          {t("DashboardCustody.policyRevisionsRawRule")}
          <ChevronRight className="ml-1 inline size-3 transition-transform group-open/rule:rotate-90" />
        </summary>
        <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-surface-sunken p-4 text-xs leading-5 text-primary">
          {JSON.stringify(rule, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function formatRuleValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function SnapshotValue({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-xs text-secondary">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm text-primary" title={value}>
        {value}
      </dd>
    </div>
  );
}
