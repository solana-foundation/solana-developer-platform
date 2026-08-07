import type { PrivateChannelInstance, PrivateChannelInstanceOverview } from "@sdp/types";
import Link from "next/link";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** Map gateway health → a connection status tag. */
function connectionStatus(
  t: Translate,
  health: PrivateChannelInstanceOverview["gateway"]["health"]
): { variant: BadgeVariant; label: string } {
  switch (health.status) {
    case "ready":
      return { variant: "success", label: t("DashboardPrivateChannels.overview.statusConnected") };
    case "degraded":
      return { variant: "warning", label: t("DashboardPrivateChannels.overview.statusDegraded") };
    default:
      return { variant: "danger", label: t("DashboardPrivateChannels.overview.statusUnreachable") };
  }
}

/** Middle-truncate a long identifier so it fits one line without a mono font. */
function shorten(value: string, head = 6, tail = 6): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** A label/value pair; when `href` is set the value is a link. */
function Field({
  label,
  value,
  title,
  href,
}: {
  label: string;
  value: string;
  title?: string;
  href?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-tertiary">{label}</div>
      {href ? (
        <Link
          href={href}
          className="block truncate text-sm text-info hover:underline"
          title={title ?? value}
        >
          {value}
        </Link>
      ) : (
        <div className="truncate text-sm text-primary" title={title ?? value}>
          {value}
        </div>
      )}
    </div>
  );
}

interface Props {
  /** The active instance + its overview, or null when nothing is connected. */
  instance: PrivateChannelInstance | null;
  overview: PrivateChannelInstanceOverview | null;
  /** Where the "Connect" link points when disconnected. */
  connectHref: string;
  /** The Instance view — the address links here to manage/disconnect. */
  instanceHref: string;
  /** The Channels view — the default channel links here. */
  channelsHref: string;
  /** Name of the instance's default channel, if one is provisioned. */
  defaultChannelName: string | null;
}

export async function ConnectedInstancePanel({
  instance,
  overview,
  connectHref,
  instanceHref,
  channelsHref,
  defaultChannelName,
}: Props) {
  const t = await getTranslations();

  const status =
    instance && overview
      ? connectionStatus(t, overview.gateway.health)
      : {
          variant: "default" as const,
          label: t("DashboardPrivateChannels.overview.statusNotConnected"),
        };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.connectedInstanceTitle")}</CardTitle>
        <CardAction>
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {instance ? (
          <>
            <Field
              label={t("DashboardPrivateChannels.overview.instanceAddressLabel")}
              value={shorten(instance.escrowInstanceAddr)}
              title={instance.escrowInstanceAddr}
              href={instanceHref}
            />
            {defaultChannelName ? (
              <Field
                label={t("DashboardPrivateChannels.overview.defaultChannelLabel")}
                value={defaultChannelName}
                href={channelsHref}
              />
            ) : null}
          </>
        ) : (
          <Link href={connectHref} className="text-sm text-info hover:underline">
            {t("DashboardPrivateChannels.overview.connectLink")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
