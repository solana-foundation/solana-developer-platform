import { type CountryCode, countryByCode } from "@sdp/types/countries";
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import {
  RecordList,
  RecordRow,
  RecordSection,
  RecordStateBand,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import type { MessageKey } from "@/i18n/messages";
import { getRequestLocale, getRequestTimeZone, getTranslations } from "@/i18n/server";
import { formatDate } from "@/lib/date-format";
import { loadMainnetAccess } from "./mainnet-access-load";
import { MainnetAccessRequestHost, MainnetAccessResendButton } from "./mainnet-access-request";

function countryLabel(code: CountryCode): string {
  const { name } = countryByCode(code);
  const flag = regionFlagEmoji(code);
  return flag ? `${flag} ${name}` : name;
}

/**
 * The organization's mainnet access (HOO-2427): a one-time request while it has none, and what
 * it declared and accepted once it asked. Changes go through the SDP alias, never this section.
 */
export async function MainnetAccessSection() {
  const [t, locale, timeZone, loaded] = await Promise.all([
    getTranslations(),
    getRequestLocale(),
    getRequestTimeZone(),
    loadMainnetAccess(),
  ]);

  if (!loaded.ok) {
    return (
      <RecordSection id="mainnet-access" title={t("Shared.mainnetAccess.title")}>
        <p className="text-body text-error" role="alert">
          {t("Shared.mainnetAccess.loadFailed", { error: loaded.error })}
        </p>
      </RecordSection>
    );
  }
  return (
    <MainnetAccessRequestHost
      canRequest={loaded.access.state === "not_requested" && loaded.access.available}
      organizationId={loaded.organizationId}
      organizationName={loaded.organizationName}
      record={
        <MainnetAccessRecord
          organizationId={loaded.organizationId}
          access={loaded.access}
          locale={locale}
          timeZone={timeZone}
          t={t}
        />
      }
    />
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function MainnetAccessRecord({
  organizationId,
  access,
  locale,
  timeZone,
  t,
}: {
  organizationId: string;
  access: MainnetAccess;
  locale: string;
  timeZone: string;
  t: Translate;
}) {
  const unsent = access.state === "pending" && access.request?.notified === false;
  const requestedOn = access.request
    ? formatDate(locale, timeZone, access.request.requestedAt)
    : null;
  return (
    <>
      {unsent ? (
        <RecordStateBand
          state={t("Shared.mainnetAccess.unsentTitle")}
          tone="attention"
          why={t("Shared.mainnetAccess.unsentBody")}
          action={
            access.available ? (
              <MainnetAccessResendButton organizationId={organizationId} />
            ) : undefined
          }
        />
      ) : null}
      <RecordList>
        <RecordRow label={t("Shared.mainnetAccess.statusLabel")} help={statusHelp(access, t)}>
          {t(STATUS_LABEL_KEYS[access.state])}
        </RecordRow>
        {requestedOn === null ? null : (
          <RecordRow label={t("Shared.mainnetAccess.requestedLabel")}>{requestedOn}</RecordRow>
        )}
        {access.countryCode ? (
          <RecordRow label={t("Shared.mainnetAccess.jurisdictionLabel")}>
            {countryLabel(access.countryCode)}
          </RecordRow>
        ) : null}
        {access.request ? (
          <RecordRow label={t("Shared.mainnetAccess.termsLabel")}>
            {requestedOn === null
              ? t("Shared.mainnetAccess.termsVersion", { version: access.request.termsVersion })
              : t("Shared.mainnetAccess.termsAcceptedValue", {
                  version: access.request.termsVersion,
                  date: requestedOn,
                })}
          </RecordRow>
        ) : null}
        {access.state === "not_requested" ? null : (
          <RecordRow
            label={t("Shared.mainnetAccess.changesLabel")}
            help={t("Shared.mainnetAccess.changesHelp")}
          >
            {access.contactEmail ? (
              <a
                className="font-medium text-primary underline underline-offset-2"
                href={`mailto:${access.contactEmail}`}
              >
                {access.contactEmail}
              </a>
            ) : (
              t("Shared.mainnetAccess.changesNoEmail")
            )}
          </RecordRow>
        )}
      </RecordList>
    </>
  );
}

const STATUS_LABEL_KEYS = {
  not_requested: "Shared.mainnetAccess.statusNotRequested",
  pending: "Shared.mainnetAccess.statusPending",
  approved: "Shared.mainnetAccess.statusApproved",
} as const satisfies Record<MainnetAccess["state"], MessageKey>;

function statusHelp(access: MainnetAccess, t: Translate): string {
  switch (access.state) {
    case "approved":
      return t("Shared.mainnetAccess.approvedBody");
    case "pending":
      return t("Shared.mainnetAccess.pendingBody");
    case "not_requested":
      return access.available
        ? t("Shared.mainnetAccess.description")
        : t("Shared.mainnetAccess.unavailableBody");
    default: {
      const exhaustive: never = access.state;
      throw new Error(`Unhandled mainnet access state: ${JSON.stringify(exhaustive)}`);
    }
  }
}
