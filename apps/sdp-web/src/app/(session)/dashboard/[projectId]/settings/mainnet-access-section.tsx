import { type CountryCode, countryByCode } from "@sdp/types/countries";
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import { DEFAULT_SDP_WEB_URL } from "@sdp/types/site";
import { Button } from "@sdp/ui/button";
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
          organizationName={loaded.organizationName}
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
  organizationName,
  access,
  locale,
  timeZone,
  t,
}: {
  organizationId: string;
  organizationName: string;
  access: MainnetAccess;
  locale: string;
  timeZone: string;
  t: Translate;
}) {
  const organization = { organization: organizationName };
  const requestedOn = access.request
    ? formatDate(locale, timeZone, access.request.requestedAt)
    : null;
  return (
    <>
      <MainnetAccessBand
        organizationId={organizationId}
        organizationName={organizationName}
        access={access}
        t={t}
      />
      <RecordList>
        {access.state === "pending" ? null : (
          <RecordRow
            label={t("Shared.mainnetAccess.statusLabel")}
            help={statusHelp(access, organizationName, t)}
          >
            {t(statusLabelKey(access))}
          </RecordRow>
        )}
        {requestedOn === null ? null : (
          <RecordRow label={t("Shared.mainnetAccess.requestedLabel")}>{requestedOn}</RecordRow>
        )}
        {access.countryCode ? (
          <RecordRow
            label={t("Shared.mainnetAccess.jurisdictionLabel")}
            help={t("Shared.mainnetAccess.jurisdictionHelp", organization)}
          >
            {countryLabel(access.countryCode)}
          </RecordRow>
        ) : null}
        {access.request && requestedOn !== null ? (
          <RecordRow label={t("Shared.mainnetAccess.termsLabel")}>
            {t("Shared.mainnetAccess.termsAcceptedValue", {
              version: access.request.termsVersion,
              date: requestedOn,
            })}
          </RecordRow>
        ) : null}
        {access.state === "not_requested" ? null : (
          <ChangesRow contactEmail={access.contactEmail} t={t} />
        )}
      </RecordList>
    </>
  );
}

/** Mainnet's own deployment, as a sandbox-only one names and links it. */
const MAINNET_HOST = new URL(DEFAULT_SDP_WEB_URL).host;

/**
 * Above the record: on a sandbox-only deployment, where mainnet is; else a request whose email did
 * not go out, or one SDP is reviewing.
 */
function MainnetAccessBand({
  organizationId,
  organizationName,
  access,
  t,
}: {
  organizationId: string;
  organizationName: string;
  access: MainnetAccess;
  t: Translate;
}) {
  if (access.sandboxOnly) {
    const host = { host: MAINNET_HOST };
    return (
      <RecordStateBand
        state={t("Shared.mainnetAccess.sandboxOnlyTitle", host)}
        tone="neutral"
        why={t("Shared.mainnetAccess.sandboxOnlyBody", host)}
        action={
          <Button asChild variant="outline" size="sm">
            <a href={DEFAULT_SDP_WEB_URL} target="_blank" rel="noreferrer">
              {t("Shared.mainnetAccess.sandboxOnlyAction", host)}
            </a>
          </Button>
        }
      />
    );
  }
  if (access.state !== "pending") return null;
  if (access.request?.notified === false) {
    return (
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
    );
  }
  return (
    <RecordStateBand
      state={t("Shared.mainnetAccess.statusPending")}
      tone="progress"
      why={t("Shared.mainnetAccess.pendingBody", { organization: organizationName })}
    />
  );
}

function ChangesRow({ contactEmail, t }: { contactEmail: string | null; t: Translate }) {
  return (
    <RecordRow
      label={t("Shared.mainnetAccess.changesLabel")}
      help={t("Shared.mainnetAccess.changesHelp")}
    >
      {contactEmail ? (
        <a
          className="font-medium text-primary underline underline-offset-2"
          href={`mailto:${contactEmail}`}
        >
          {contactEmail}
        </a>
      ) : (
        t("Shared.mainnetAccess.changesNoEmail")
      )}
    </RecordRow>
  );
}

const STATUS_LABEL_KEYS = {
  not_requested: "Shared.mainnetAccess.statusNotRequested",
  pending: "Shared.mainnetAccess.statusPending",
  approved: "Shared.mainnetAccess.statusApproved",
} as const satisfies Record<MainnetAccess["state"], MessageKey>;

/** A deployment that serves mainnet only has no sandbox to fall back on, so "Sandbox only" would mislead. */
function statusLabelKey(access: MainnetAccess): MessageKey {
  return access.state === "not_requested" && access.mainnetOnly
    ? "Shared.mainnetAccess.statusLocked"
    : STATUS_LABEL_KEYS[access.state];
}

function statusHelp(access: MainnetAccess, organization: string, t: Translate): string {
  switch (access.state) {
    case "approved":
      return t("Shared.mainnetAccess.approvedBody", { organization });
    case "pending":
      return t("Shared.mainnetAccess.pendingBody", { organization });
    case "not_requested":
      if (access.sandboxOnly)
        return t("Shared.mainnetAccess.sandboxOnlyBody", { host: MAINNET_HOST });
      if (!access.available) return t("Shared.mainnetAccess.unavailableBody");
      return access.mainnetOnly
        ? t("Shared.mainnetAccess.lockedDescription", { organization })
        : t("Shared.mainnetAccess.description", { organization });
    default: {
      const exhaustive: never = access.state;
      throw new Error(`Unhandled mainnet access state: ${JSON.stringify(exhaustive)}`);
    }
  }
}
