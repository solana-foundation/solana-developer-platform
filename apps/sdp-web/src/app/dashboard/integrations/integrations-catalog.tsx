import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import type { ReactNode } from "react";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import type { IntegrationEntry, IntegrationStatus } from "./integrations-status";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function StatusBadge({ status, t }: { status: IntegrationStatus; t: Translate }) {
  if (status === "active") {
    return (
      <span className="rounded-full bg-surface-raised px-3 py-1 text-xs font-medium text-secondary ring-1 ring-border-subtle">
        {t("Shared.integrations.statusActive")}
      </span>
    );
  }
  if (status === "available") {
    return (
      <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
        {t("Shared.integrations.statusAvailable")}
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
        {t("Shared.integrations.statusPending")}
      </span>
    );
  }
  if (status === "request_access") {
    return (
      <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
        {t("Shared.integrations.statusRequestAccess")}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-tertiary">
      {t("Shared.integrations.statusNotAvailable")}
    </span>
  );
}

function IntegrationRow({
  icon,
  title,
  description,
  status,
  action,
  t,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  status: IntegrationStatus;
  action?: ReactNode;
  t: Translate;
}) {
  return (
    <li
      className="flex items-center gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-4"
      data-integration-row="true"
      data-integration-status={status}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-strong">
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-primary">{title}</span>
          <StatusBadge status={status} t={t} />
        </span>
        {description ? (
          <span className="block text-sm leading-5 text-tertiary">{description}</span>
        ) : null}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </li>
  );
}

function FamilySection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium tracking-tight text-primary">{title}</h2>
        <p className="text-sm leading-5 text-tertiary">{description}</p>
      </div>
      <ul className="grid gap-3">{children}</ul>
    </section>
  );
}

function NeutralMark({ label }: { label: string }) {
  return (
    <span aria-hidden className="text-sm font-semibold text-secondary">
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

export async function IntegrationsCatalog({
  custody,
  rpc,
  ramps,
  compliance,
}: {
  /** `null` when the connected-provider lookup failed: state unknown, not empty. */
  custody: CustodyProviderAvailability[] | null;
  rpc: IntegrationEntry<OrganizationRpcProvider>[];
  ramps: IntegrationEntry<RampProviderId>[];
  compliance: IntegrationEntry<ComplianceProviderId>[];
}) {
  const t = await getTranslations();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-4 py-6 md:px-6">
      <p className="max-w-2xl text-sm leading-6 text-tertiary">
        {t("Shared.integrations.pageDescription")}
      </p>

      <FamilySection
        title={t("Shared.integrations.custodyTitle")}
        description={t("Shared.integrations.custodyDescription")}
      >
        {custody === null ? (
          <li
            role="alert"
            className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
          >
            {t("Shared.integrations.custodyUnavailable")}
          </li>
        ) : null}
        {(custody ?? []).map((provider) => (
          <IntegrationRow
            key={provider.entry.id}
            icon={<WalletProviderMark provider={provider.entry.id} size="sm" />}
            title={provider.entry.label}
            description={t(provider.entry.descriptionKey)}
            status={provider.status}
            t={t}
            action={
              provider.status === "active" ? (
                <Button asChild variant="secondary" size="sm">
                  <DashboardNavigationLink href="/dashboard/wallets">
                    {t("Shared.integrations.ctaManage")}
                  </DashboardNavigationLink>
                </Button>
              ) : provider.status === "available" ? (
                <Button asChild variant="secondary" size="sm">
                  <DashboardNavigationLink
                    href={`/dashboard/wallets/setup?provider=${provider.entry.id}`}
                  >
                    {t("Shared.integrations.ctaConfigure")}
                  </DashboardNavigationLink>
                </Button>
              ) : provider.status === "request_access" &&
                provider.entry.storedCredentialSetup.mode === "request_access" ? (
                <Button asChild variant="secondary" size="sm">
                  <a
                    href={provider.entry.storedCredentialSetup.requestAccessUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("Shared.integrations.ctaRequestAccess")}
                  </a>
                </Button>
              ) : undefined
            }
          />
        ))}
      </FamilySection>

      <FamilySection
        title={t("Shared.integrations.rpcTitle")}
        description={t("Shared.integrations.rpcDescription")}
      >
        {rpc.map((provider) => (
          <IntegrationRow
            key={provider.provider}
            icon={<RpcProviderMark provider={provider.provider} />}
            title={provider.label}
            status={provider.status}
            t={t}
            action={
              provider.status === "active" || provider.status === "available" ? (
                <Button asChild variant="secondary" size="sm">
                  <DashboardNavigationLink href="/dashboard/settings">
                    {t("Shared.integrations.ctaManage")}
                  </DashboardNavigationLink>
                </Button>
              ) : undefined
            }
          />
        ))}
      </FamilySection>

      <FamilySection
        title={t("Shared.integrations.rampsTitle")}
        description={t("Shared.integrations.rampsDescription")}
      >
        {ramps.map((provider) => (
          <IntegrationRow
            key={provider.provider}
            icon={<NeutralMark label={provider.label} />}
            title={provider.label}
            status={provider.status}
            t={t}
            action={
              provider.status === "active" ? (
                <Button asChild variant="secondary" size="sm">
                  <DashboardNavigationLink href="/dashboard/payments/deposit">
                    {t("Shared.integrations.ctaManage")}
                  </DashboardNavigationLink>
                </Button>
              ) : undefined
            }
          />
        ))}
      </FamilySection>

      <FamilySection
        title={t("Shared.integrations.complianceTitle")}
        description={t("Shared.integrations.complianceDescription")}
      >
        {compliance.map((provider) => (
          <IntegrationRow
            key={provider.provider}
            icon={<NeutralMark label={provider.label} />}
            title={provider.label}
            status={provider.status}
            t={t}
          />
        ))}
      </FamilySection>
    </div>
  );
}
