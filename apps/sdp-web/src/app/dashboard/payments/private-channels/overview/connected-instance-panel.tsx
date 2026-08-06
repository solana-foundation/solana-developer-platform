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

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-tertiary">{label}</div>
      <div className="truncate text-sm text-primary" title={title ?? value}>
        {value}
      </div>
    </div>
  );
}

interface Props {
  /** The active instance + its overview, or null when nothing is connected. */
  instance: PrivateChannelInstance | null;
  overview: PrivateChannelInstanceOverview | null;
  /** Where the "Connect" link points when disconnected. */
  connectHref: string;
}

export async function ConnectedInstancePanel({ instance, overview, connectHref }: Props) {
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
            />
            <Field
              label={t("DashboardPrivateChannels.overview.gatewayUrlLabel")}
              value={instance.gatewayUrl}
            />
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
