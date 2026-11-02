import { type CountryCode, countryByCode } from "@sdp/types/countries";
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import { Badge } from "@sdp/ui/badge";
import { Callout } from "@sdp/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { loadMainnetAccess } from "./mainnet-access-actions";
import { MainnetAccessRequestHost, MainnetAccessResendButton } from "./mainnet-access-request";

function countryLabel(code: CountryCode): string {
  const { name } = countryByCode(code);
  const flag = regionFlagEmoji(code);
  return flag ? `${flag} ${name}` : name;
}

/** One formatter per locale for the life of the server, not one per render. */
const MEDIUM_DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function mediumDateFormat(locale: string): Intl.DateTimeFormat {
  const cached = MEDIUM_DATE_FORMATS.get(locale);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  MEDIUM_DATE_FORMATS.set(locale, format);
  return format;
}

/**
 * The organization's mainnet access (HOO-2427): a one-time request while it has none, and what
 * it declared and accepted once it asked. Changes go through the SDP alias, never this card.
 */
export async function MainnetAccessSection() {
  const [t, locale, loaded] = await Promise.all([
    getTranslations(),
    getRequestLocale(),
    loadMainnetAccess(),
  ]);
  const dateFormat = mediumDateFormat(locale);
  const formatDate = (iso: string) => dateFormat.format(new Date(iso));

  return (
    <Card id="mainnet-access" className="scroll-mt-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{t("Shared.mainnetAccess.title")}</CardTitle>
          {loaded.ok ? <MainnetAccessBadge access={loaded.access} t={t} /> : null}
        </div>
        <CardDescription>{t("Shared.mainnetAccess.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loaded.ok ? (
          <MainnetAccessRequestHost
            canRequest={loaded.access.state === "not_requested" && loaded.access.available}
            organizationName={loaded.organizationName}
            record={<MainnetAccessRecord access={loaded.access} formatDate={formatDate} t={t} />}
          />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {t("Shared.mainnetAccess.loadFailed", { error: loaded.error })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function MainnetAccessBadge({ access, t }: { access: MainnetAccess; t: Translate }) {
  if (access.state === "approved") {
    return <Badge variant="success">{t("Shared.mainnetAccess.statusApproved")}</Badge>;
  }
  if (access.state === "pending") {
    return <Badge variant="warning">{t("Shared.mainnetAccess.statusPending")}</Badge>;
  }
  return null;
}

function MainnetAccessRecord({
  access,
  formatDate,
  t,
}: {
  access: MainnetAccess;
  formatDate: (iso: string) => string;
  t: Translate;
}) {
  if (access.state === "not_requested") {
    // Only reached while the deployment takes no requests: the card offers none.
    return <p className="text-sm text-secondary">{t("Shared.mainnetAccess.unavailableBody")}</p>;
  }
  const unsent = access.state === "pending" && access.request?.notified === false;
  return (
    <>
      {unsent ? (
        <Callout variant="warning" title={t("Shared.mainnetAccess.unsentTitle")}>
          <div className="flex flex-col items-start gap-3">
            <span>{t("Shared.mainnetAccess.unsentBody")}</span>
            {access.available ? <MainnetAccessResendButton /> : null}
          </div>
        </Callout>
      ) : (
        <p className="text-sm text-secondary">
          {access.state === "approved"
            ? t("Shared.mainnetAccess.approvedBody")
            : t("Shared.mainnetAccess.pendingBody")}
        </p>
      )}

      {access.request ? (
        <DetailList>
          {access.countryCode ? (
            <DetailRow label={t("Shared.mainnetAccess.jurisdictionLabel")}>
              {countryLabel(access.countryCode)}
            </DetailRow>
          ) : null}
          <DetailRow label={t("Shared.mainnetAccess.termsLabel")} fit="wrap">
            {t("Shared.mainnetAccess.termsAcceptedValue", {
              version: access.request.termsVersion,
              date: formatDate(access.request.requestedAt),
            })}
          </DetailRow>
          <DetailRow label={t("Shared.mainnetAccess.requestedLabel")}>
            {formatDate(access.request.requestedAt)}
          </DetailRow>
        </DetailList>
      ) : null}

      <p className="text-sm text-tertiary">
        {access.contactEmail ? (
          <>
            {t("Shared.mainnetAccess.changeHintPrefix")}{" "}
            <a
              className="whitespace-nowrap font-medium text-primary underline underline-offset-2"
              href={`mailto:${access.contactEmail}`}
            >
              {access.contactEmail}
            </a>
            .
          </>
        ) : (
          t("Shared.mainnetAccess.changeHintNoEmail")
        )}
      </p>
    </>
  );
}
