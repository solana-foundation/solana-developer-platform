import type { OrganizationRpcProvider } from "@sdp/types";
import Image from "next/image";
import { CUSTODY_CAPABILITY_LABEL_KEYS } from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { docsHref } from "@/components/dashboard-nav";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import type { IntegrationDetail } from "../integration-detail";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function statusKey(status: IntegrationDetail["status"]): Parameters<Translate>[0] {
  switch (status) {
    case "active":
      return "Shared.integrations.statusActive";
    case "available":
      return "Shared.integrations.statusAvailable";
    case "enabled":
      return "Shared.integrations.statusEnabled";
    case "request_access":
      return "Shared.integrations.statusRequestAccess";
    case "not_configured":
      return "Shared.integrations.statusNotConfigured";
    default:
      return "Shared.integrations.statusUnknown";
  }
}

function familyKey(family: IntegrationDetail["family"]): Parameters<Translate>[0] {
  return (
    {
      custody: "Shared.integrations.custodyTitle",
      rpc: "Shared.integrations.rpcTitle",
      ramps: "Shared.integrations.rampsTitle",
      compliance: "Shared.integrations.complianceTitle",
    } as const
  )[family];
}

function DetailMark({ detail }: { detail: IntegrationDetail }) {
  if (detail.family === "custody" && detail.custodyEntry) {
    return <WalletProviderMark provider={detail.custodyEntry.id} size="sm" />;
  }
  if (detail.family === "rpc") {
    return <RpcProviderMark provider={detail.provider as OrganizationRpcProvider} />;
  }
  const src =
    detail.family === "ramps"
      ? RAMP_PROVIDER_LOGOS[detail.provider as keyof typeof RAMP_PROVIDER_LOGOS]
      : COMPLIANCE_PROVIDER_LOGOS[detail.provider as keyof typeof COMPLIANCE_PROVIDER_LOGOS];
  return (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-[white]"
    >
      <span className="relative h-full w-full p-1">
        <Image src={src} alt="" fill sizes="28px" className="object-contain" />
      </span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <h2 className="text-base font-medium text-primary">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function resolvePrimaryAction(detail: IntegrationDetail, t: Translate) {
  // With the connection state unreadable, no state-dependent action is honest.
  if (detail.status === "unknown") {
    return null;
  }
  if (detail.family === "custody" && detail.status === "active") {
    return (
      <Button asChild>
        <DashboardNavigationLink href="/dashboard/wallets">
          {t("Shared.integrations.ctaManage")}
        </DashboardNavigationLink>
      </Button>
    );
  }
  if (detail.family === "custody" && detail.status === "available") {
    return (
      <Button asChild>
        <DashboardNavigationLink href={`/dashboard/wallets/setup?provider=${detail.provider}`}>
          {t("Shared.integrations.ctaConfigure")}
        </DashboardNavigationLink>
      </Button>
    );
  }
  if (detail.requestAccessUrl) {
    return (
      <Button asChild>
        <a href={detail.requestAccessUrl} target="_blank" rel="noreferrer noopener">
          {t("Shared.integrations.ctaRequestAccess")}
        </a>
      </Button>
    );
  }
  if (detail.family === "rpc") {
    return (
      <Button asChild variant="secondary">
        <DashboardNavigationLink href="/dashboard/settings">
          {t("Shared.integrations.rpcSectionAction")}
        </DashboardNavigationLink>
      </Button>
    );
  }
  return null;
}

export async function IntegrationDetailView({ detail }: { detail: IntegrationDetail }) {
  const t = await getTranslations();
  const entry = detail.custodyEntry;

  const primaryAction = resolvePrimaryAction(detail, t);

  return (
    <div className="w-full space-y-6 px-4 py-6 md:px-6" data-integration-detail={detail.provider}>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised p-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-fill-strong">
            <DetailMark detail={detail} />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-medium tracking-tight text-primary">
                {detail.label}
              </h1>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
                {t(statusKey(detail.status))}
              </span>
            </div>
            <p className="text-sm text-tertiary">
              {t(familyKey(detail.family))}
              {entry
                ? ` · ${t(
                    entry.category === "server"
                      ? "DashboardCustody.providerCategoryApi"
                      : "DashboardCustody.providerCategoryInstitutional"
                  )}`
                : ""}
            </p>
          </div>
        </div>
        {primaryAction}
      </header>

      {detail.descriptionKey ? (
        <Section title={t("Shared.integrations.detailAbout")}>
          <p className="max-w-2xl text-sm leading-6 text-secondary">{t(detail.descriptionKey)}</p>
        </Section>
      ) : null}

      {entry ? (
        <Section title={t("Shared.integrations.detailCapabilities")}>
          <ul className="flex flex-wrap gap-2">
            {entry.useCases.map((useCase) => (
              <li
                key={useCase}
                className="rounded-full bg-fill-subtle px-3 py-1 text-sm text-secondary"
              >
                {t(CUSTODY_CAPABILITY_LABEL_KEYS[useCase])}
              </li>
            ))}
            {entry.technicalCapabilities.supportsSigning ? (
              <li className="rounded-full bg-fill-subtle px-3 py-1 text-sm text-secondary">
                {t("Shared.integrations.capabilitySigning")}
              </li>
            ) : null}
            {entry.technicalCapabilities.supportsAdditionalWalletCreation ? (
              <li className="rounded-full bg-fill-subtle px-3 py-1 text-sm text-secondary">
                {t("Shared.integrations.capabilityAdditionalWallets")}
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      {/* Every status that is not "Connected" asks the reader to do something,
          so this section always renders: a provider must never say "request
          access" without saying anywhere how the request is made. */}
      <Section title={t("Shared.integrations.detailHowItConnects")}>
        {entry?.storedCredentialSetup.mode === "self_service" ? (
          <div className="space-y-3">
            <p className="max-w-2xl text-sm leading-6 text-secondary">
              {t("Shared.integrations.connectSelfServe")}
            </p>
            <p className="text-xs font-medium tracking-wide text-tertiary uppercase">
              {t("Shared.integrations.connectYouWillNeed")}
            </p>
            <ul className="flex flex-wrap gap-2">
              {entry.storedCredentialSetup.fields
                .filter((field) => field.key !== "credentialLabel" && field.key !== "scope")
                .map((field) => (
                  <li
                    key={field.key}
                    className="rounded-full bg-fill-subtle px-3 py-1 text-sm text-secondary"
                  >
                    {t(field.labelKey)}
                  </li>
                ))}
            </ul>
          </div>
        ) : entry?.availability === "manual" || detail.status === "request_access" ? (
          // Manual providers, whether or not a request route is wired yet
          // (HOO-775): access is granted by the SDP team, and the page must say
          // so even when the header has no request button to offer.
          <p className="max-w-2xl text-sm leading-6 text-secondary">
            {t("Shared.integrations.connectByArrangement")}
          </p>
        ) : (
          // Generally available providers riding deployment credentials, and
          // the deployment-wide rails: the SDP operator turns these on.
          <p className="max-w-2xl text-sm leading-6 text-secondary">
            {t("Shared.integrations.connectManaged")}
          </p>
        )}
      </Section>

      <Section title={t("Shared.integrations.detailResources")}>
        {/* The access request already leads the header; repeating it here read
            as noise, so resources carry only what the header does not. */}
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary" size="sm">
            <a href={docsHref} target="_blank" rel="noreferrer noopener">
              {t("Shared.integrations.detailDocs")}
            </a>
          </Button>
        </div>
      </Section>
    </div>
  );
}
