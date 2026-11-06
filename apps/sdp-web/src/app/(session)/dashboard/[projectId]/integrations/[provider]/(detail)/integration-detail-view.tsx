import type { CustodyWalletSummary } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
import {
  CustodyConnectionsSection,
  CustodyConnectionsSigningLine,
} from "@/app/(session)/dashboard/[projectId]/integrations/custody-connections-section";
import type { IntegrationDetail } from "@/app/(session)/dashboard/[projectId]/integrations/integration-detail";
import { custodyUseCasesInDeploymentReleaseChannel } from "@/app/(session)/dashboard/[projectId]/integrations/integration-feature-gates";
import type {
  ConnectionsFilters,
  ConnectionsPageResult,
  ConnectionsProjectSummary,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import { CUSTODY_CAPABILITY_LABEL_KEYS } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { docsHref } from "@/components/dashboard-nav";
import {
  RecordBlock,
  RecordLine,
  RecordStack,
  StateBand,
  type StateBandTone,
} from "@/components/refresh-record";
import { getTranslations } from "@/i18n/server";
import { requestProjectHref } from "@/lib/sdp-api";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

const STATE_BANDS = {
  active: { tone: "ok", key: "Shared.integrations.statusActive" },
  available: { tone: "neutral", key: "Shared.integrations.statusAvailable" },
  enabled: { tone: "ok", key: "Shared.integrations.statusEnabled" },
  unknown: { tone: "warn", key: "Shared.integrations.statusUnknown" },
} as const satisfies Record<
  IntegrationDetail["status"],
  { tone: StateBandTone; key: Parameters<Translate>[0] }
>;

const FAMILY_TITLE_KEYS = {
  custody: "Shared.integrations.custodyTitle",
  ramps: "Shared.integrations.rampsTitle",
  compliance: "Shared.integrations.complianceTitle",
  privacy: "Shared.integrations.privacyTitle",
} as const satisfies Record<IntegrationDetail["family"], Parameters<Translate>[0]>;

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
 * Who sets the provider up: the tenant from the Dashboard, the SDP team by
 * arrangement, or the deployment's operator. The hint says how.
 */
function setUpBy(detail: IntegrationDetail, t: Translate) {
  const entry = detail.custodyEntry;
  if (entry?.storedCredentialSetup.mode === "self_service") {
    return {
      value: t("Shared.integrations.setUpBySelf", { provider: detail.label }),
      hint: t("Shared.integrations.connectSelfServe"),
    };
  }
  if (entry?.availability === "manual") {
    return {
      value: t("Shared.integrations.setUpBySdpTeam"),
      hint: t("Shared.integrations.connectByArrangement"),
    };
  }
  return {
    value: t("Shared.integrations.setUpByOperator"),
    hint: t("Shared.integrations.connectManaged"),
  };
}

/**
 * The band's one action, if the provider's state offers one. An active
 * provider with a connections list needs none: the list is where it is managed.
 */
async function resolveBandAction(
  detail: IntegrationDetail,
  hasConnections: boolean,
  canManageCustody: boolean,
  t: Translate
) {
  if (detail.family !== "custody" || detail.status === "unknown") {
    return null;
  }
  if (detail.status === "active" && !hasConnections) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={await requestProjectHref("/dashboard/wallets")}>
          {t("Shared.integrations.ctaManage")}
        </Link>
      </Button>
    );
  }
  if (detail.status === "available" && canManageCustody && !hasConnections) {
    return (
      <Button asChild size="sm">
        <Link
          href={await requestProjectHref(`/dashboard/wallets/setup?provider=${detail.provider}`)}
        >
          {t("Shared.integrations.ctaConfigure")}
        </Link>
      </Button>
    );
  }
  return null;
}

function bandBody(
  detail: IntegrationDetail,
  custodyConnections: CustodyConnectionsContext,
  t: Translate
) {
  if (custodyConnections && custodyConnections !== "restricted") {
    return (
      <CustodyConnectionsSigningLine
        total={custodyConnections.result.pagination.total}
        summary={custodyConnections.summary}
      />
    );
  }
  if (detail.status === "unknown" && detail.family === "custody") {
    return t("Shared.integrations.custodyUnavailable");
  }
  return null;
}

function DetailsBlock({ detail, t }: { detail: IntegrationDetail; t: Translate }) {
  const entry = detail.custodyEntry;
  const setup = setUpBy(detail, t);
  const credentialFields =
    entry?.storedCredentialSetup.mode === "self_service"
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
          {t(FAMILY_TITLE_KEYS[detail.family])}
        </RecordLine>
        {entry ? (
          <>
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
          </>
        ) : null}
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
              {t("Shared.integrations.credentialFromProvider", { provider: detail.label })}
            </RecordLine>
          )
        )}
        <RecordLine label={t("Shared.integrations.detailResources")}>
          <a
            href={docsHref}
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
 * One provider's detail page under the header that names it: its state, the
 * project's connections where it has them, and its details.
 *
 * @param props - The component props.
 * @param props.detail - The resolved provider detail.
 * @param props.custodyConnections - The project's custody connections, or why there are none.
 * @param props.canManageCustody - Whether the viewer may manage custody connections.
 * @returns The rendered detail page.
 */
export async function IntegrationDetailView({
  detail,
  custodyConnections = null,
  canManageCustody = false,
}: {
  detail: IntegrationDetail;
  custodyConnections?: CustodyConnectionsContext;
  canManageCustody?: boolean;
}) {
  const t = await getTranslations();
  const band = STATE_BANDS[detail.status];
  const connections =
    custodyConnections && custodyConnections !== "restricted" && detail.custodyEntry
      ? custodyConnections
      : null;

  return (
    <div className="@container w-full" data-integration-detail={detail.provider}>
      <RecordStack spacing="compact">
        <StateBand
          tone={band.tone}
          state={t(band.key)}
          action={await resolveBandAction(detail, custodyConnections !== null, canManageCustody, t)}
        >
          {bandBody(detail, custodyConnections, t)}
        </StateBand>

        {custodyConnections === "restricted" ? (
          <RecordBlock title={t("DashboardCustody.connectionsTitle")}>
            <p className="text-body text-secondary">{t("DashboardCustody.readOnlyViewer")}</p>
          </RecordBlock>
        ) : null}

        {connections && detail.custodyEntry ? (
          <CustodyConnectionsSection
            result={connections.result}
            filters={connections.filters}
            summary={connections.summary}
            walletsByConnection={connections.walletsByConnection}
            walletsUnavailable={connections.walletsUnavailable}
            canManageCustody={canManageCustody}
            provider={detail.custodyEntry.id}
          />
        ) : null}

        <DetailsBlock detail={detail} t={t} />
      </RecordStack>
    </div>
  );
}
