"use client";

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
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDate } from "@/lib/date-format";
import { MainnetAccessRequestHost, MainnetAccessResendButton } from "./mainnet-access-request";
import { useCurrentOrganization, useMainnetAccess } from "./organization.data";
import {
  SettingsLoadError,
  SettingsRowsSkeleton,
  useReadFailureText,
} from "./settings-section-state";

function countryLabel(code: CountryCode): string {
  const { name } = countryByCode(code);
  const flag = regionFlagEmoji(code);
  return flag ? `${flag} ${name}` : name;
}

/**
 * The organization's mainnet access (HOO-2427): a one-time request while it has none, and what
 * it declared and accepted once it asked. Changes go through the SDP alias, never this section.
 */
export function MainnetAccessSection() {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const failureText = useReadFailureText();
  const organization = useCurrentOrganization();
  const access = useMainnetAccess(organization.data ? organization.data.id : null);

  if (organization.data && access.data) {
    return (
      <MainnetAccessRequestHost
        canRequest={access.data.state === "not_requested" && access.data.available}
        organizationId={organization.data.id}
        organizationName={organization.data.name}
        record={
          <MainnetAccessRecord
            organizationId={organization.data.id}
            access={access.data}
            locale={locale}
            timeZone={timeZone}
            t={t}
          />
        }
      />
    );
  }
  const failedRead = organization.error ? organization : access.error ? access : null;
  return (
    <RecordSection id="mainnet-access" title={t("Shared.mainnetAccess.title")}>
      {failedRead?.error ? (
        <SettingsLoadError
          message={t("Shared.mainnetAccess.loadFailed", { error: failureText(failedRead.error) })}
          onRetry={() => void failedRead.mutate()}
        />
      ) : (
        <SettingsRowsSkeleton rows={2} />
      )}
    </RecordSection>
  );
}

type Translate = ReturnType<typeof useTranslations>;

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
