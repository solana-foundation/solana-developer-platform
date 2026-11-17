import type { CustodyProviderUseCase, CustodyWalletSummary } from "@sdp/types/custody";
import type { CustodyIntegration, IntegrationState } from "@sdp/types/integrations";
import type { SdpModule } from "@sdp/types/release-channels";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
import {
  CustodyConnectionsSection,
  CustodyConnectionsSigningLine,
} from "@/app/(session)/dashboard/[projectId]/integrations/custody-connections-section";
import type {
  ConnectionsFilters,
  ConnectionsPageResult,
  ConnectionsProjectSummary,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import {
  CUSTODY_CAPABILITY_LABEL_KEYS,
  type CustodyProviderCatalogEntry,
  getCustodyProviderEntry,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import {
  RecordBlock,
  RecordLine,
  RecordStack,
  StateBand,
  type StateBandTone,
} from "@/components/refresh-record";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { getTranslations } from "@/i18n/server";
import { resolveDocsUrl } from "@/lib/docs-url";
import { requestProjectHref } from "@/lib/sdp-api";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** The module that delivers each custody use case. Transfers are custody wallets' own. */
const CUSTODY_USE_CASE_MODULES = {
  issuance: "issuance",
  transfers: "custody",
  compliance: "compliance",
} as const satisfies Record<CustodyProviderUseCase, SdpModule>;

/**
 * A custody provider's use cases the deployment's release channel runs, so its Capabilities
 * never advertise a module the deployment refuses (Issuance on `stable`).
 *
 * @param useCases - The provider's use cases.
 * @returns The use cases whose module the channel runs, in their given order.
 */
function custodyUseCasesInDeploymentReleaseChannel(
  useCases: readonly CustodyProviderUseCase[]
): CustodyProviderUseCase[] {
  return useCases.filter((useCase) =>
    isModuleInDeploymentReleaseChannel(CUSTODY_USE_CASE_MODULES[useCase])
  );
}

const STATE_BANDS = {
  connected: { tone: "ok", key: "Shared.integrations.stateConnected" },
  provided: { tone: "neutral", key: "Shared.integrations.stateProvided" },
  not_configured: { tone: "neutral", key: "Shared.integrations.stateNotConfigured" },
} as const satisfies Record<
  IntegrationState["status"],
  { tone: StateBandTone; key: Parameters<Translate>[0] }
>;

/**
 * The project's custody connections, or the reason there are none to show.
 * `null` means the section does not apply here; `"restricted"` means the
 * viewer cannot read them.
 */
export type CustodyConnectionsContext =
  | {
      result: ConnectionsPageResult;
      filters: ConnectionsFilters;
      summary: ConnectionsProjectSummary;
      walletsByConnection: Record<string, CustodyWalletSummary[]>;
      walletsUnavailable: boolean;
    }
  | "restricted"
  | null;

/**
 * Who sets the provider up: the tenant from the Dashboard, or the deployment's
 * operator. The hint says how.
 */
function setUpBy(entry: CustodyProviderCatalogEntry, t: Translate) {
  if (entry.storedCredentialSetup.mode === "self_service") {
    return {
      value: t("Shared.integrations.setUpBySelf", { provider: entry.label }),
      hint: t("Shared.integrations.connectSelfServe"),
    };
  }
  return {
    value: t("Shared.integrations.setUpByOperator"),
    hint: t("Shared.integrations.connectManaged"),
  };
}

/**
 * The band's one action, if the provider's state offers one. A provider with a
 * connections section, readable or restricted, needs none: the section is where
 * it is managed.
 */
async function resolveBandAction(
  integration: CustodyIntegration,
  hasConnections: boolean,
  canManageCustody: boolean,
  t: Translate
) {
  if (hasConnections) {
    return null;
  }
  if (integration.state.status === "connected") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={await requestProjectHref("/dashboard/wallets")}>
          {t("Shared.integrations.ctaManage")}
        </Link>
      </Button>
    );
  }
  if (integration.state.status === "not_configured" && canManageCustody) {
    return (
      <Button asChild size="sm">
        <Link
          href={
            await requestProjectHref(`/dashboard/wallets/setup?provider=${integration.provider}`)
          }
        >
          {t("Shared.integrations.ctaConfigure")}
        </Link>
      </Button>
    );
  }
  return null;
}

function DetailsBlock({ entry, t }: { entry: CustodyProviderCatalogEntry; t: Translate }) {
  const setup = setUpBy(entry, t);
  const credentialFields =
    entry.storedCredentialSetup.mode === "self_service"
      ? entry.storedCredentialSetup.fields.filter(
          (field) => field.key !== "credentialLabel" && field.key !== "scope"
        )
      : [];
  const yesNo = (value: boolean) =>
    value ? t("Shared.integrations.detailYes") : t("Shared.integrations.detailNo");

  return (
    <RecordBlock title={t("Shared.integrations.detailsTitle")}>
      <dl>
        <RecordLine label={t("Shared.integrations.detailFamily")}>
          {t("Shared.integrations.custodyTitle")}
        </RecordLine>
        <RecordLine label={t("Shared.integrations.detailKind")}>
          {t(
            entry.category === "server"
              ? "DashboardCustody.providerCategoryApi"
              : "DashboardCustody.providerCategoryInstitutional"
          )}
        </RecordLine>
        <RecordLine label={t("Shared.integrations.detailUsedFor")}>
          {custodyUseCasesInDeploymentReleaseChannel(entry.useCases)
            .map((useCase) => t(CUSTODY_CAPABILITY_LABEL_KEYS[useCase]))
            .join(", ")}
        </RecordLine>
        <RecordLine
          label={t("Shared.integrations.capabilitySigning")}
          hint={t("Shared.integrations.capabilitySigningHint")}
        >
          {yesNo(entry.technicalCapabilities.supportsSigning)}
        </RecordLine>
        <RecordLine
          label={t("Shared.integrations.capabilityAdditionalWallets")}
          hint={t("Shared.integrations.capabilityAdditionalWalletsHint")}
        >
          {yesNo(entry.technicalCapabilities.supportsAdditionalWalletCreation)}
        </RecordLine>
        <RecordLine label={t("Shared.integrations.detailSetUpBy")} hint={setup.hint}>
          {setup.value}
        </RecordLine>
        {credentialFields.map((field) =>
          field.valueHandling === "secret" ? (
            <RecordLine key={field.key} label={t(field.labelKey)}>
              {t("Shared.integrations.credentialWriteOnly")}
            </RecordLine>
          ) : (
            <RecordLine key={field.key} label={t(field.labelKey)} hint={t(field.helpTextKey)}>
              {t("Shared.integrations.credentialFromProvider", { provider: entry.label })}
            </RecordLine>
          )
        )}
        <RecordLine label={t("Shared.integrations.detailResources")}>
          <a
            href={resolveDocsUrl(
              entry.id === "fireblocks" ? "wallet-operations/fireblocks" : undefined
            )}
            target="_blank"
            rel="noreferrer noopener"
            className="underline-offset-4 hover:underline"
          >
            {t("Shared.integrations.detailDocs")}
          </a>
        </RecordLine>
      </dl>
    </RecordBlock>
  );
}

/**
 * One custody provider's detail page under the header that names it: its
 * state from the integrations read, the project's connections where it has
 * them, and its details.
 */
export async function IntegrationDetailView({
  integration,
  custodyConnections,
  canManageCustody,
}: {
  integration: CustodyIntegration;
  custodyConnections: CustodyConnectionsContext;
  canManageCustody: boolean;
}) {
  const t = await getTranslations();
  const entry = getCustodyProviderEntry(integration.provider);
  const band = STATE_BANDS[integration.state.status];
  const connections =
    custodyConnections && custodyConnections !== "restricted" ? custodyConnections : null;

  return (
    <div className="@container w-full" data-integration-detail={integration.provider}>
      <RecordStack spacing="compact">
        <StateBand
          tone={band.tone}
          state={t(band.key)}
          action={
            await resolveBandAction(integration, custodyConnections !== null, canManageCustody, t)
          }
        >
          {connections ? (
            <CustodyConnectionsSigningLine
              total={connections.result.pagination.total}
              summary={connections.summary}
            />
          ) : null}
        </StateBand>

        {custodyConnections === "restricted" ? (
          <RecordBlock title={t("DashboardCustody.connectionsTitle")}>
            <p className="text-body text-secondary">{t("DashboardCustody.readOnlyViewer")}</p>
          </RecordBlock>
        ) : null}

        {connections ? (
          <CustodyConnectionsSection
            result={connections.result}
            filters={connections.filters}
            summary={connections.summary}
            walletsByConnection={connections.walletsByConnection}
            walletsUnavailable={connections.walletsUnavailable}
            canManageCustody={canManageCustody}
            provider={integration.provider}
          />
        ) : null}

        <DetailsBlock entry={entry} t={t} />
      </RecordStack>
    </div>
  );
}
