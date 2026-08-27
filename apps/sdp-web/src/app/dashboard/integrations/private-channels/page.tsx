import { VenetianMaskIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "./private-channels-access";
import { loadInstance } from "./private-channels-page.data";
import {
  PRIVATE_CHANNELS_OVERVIEW_PATH,
  PRIVATE_CHANNELS_SETUP_PATH,
} from "./private-channels-routes";

export default async function PrivateChannelsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();
  const client = await createSdpApiClient();
  const instance = await loadInstance(client);
  const connected = instance.data?.isActive === true;
  const status = !instance.ok
    ? t("Shared.integrations.statusUnknown")
    : connected
      ? t("Shared.integrations.statusActive")
      : t("Shared.integrations.statusAvailable");

  return (
    <div className="w-full space-y-6" data-integration-detail="private-channels">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised p-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-fill-strong">
            <VenetianMaskIcon aria-hidden className="size-6 text-secondary" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-medium tracking-tight text-primary">
                {t("Shared.dashboardShell.privateChannels")}
              </h1>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
                {status}
              </span>
            </div>
            <p className="text-sm text-tertiary">{t("Shared.integrations.privacyTitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {connected ? (
            <Button asChild variant="secondary">
              <Link href={PRIVATE_CHANNELS_OVERVIEW_PATH}>
                {t("Shared.integrations.privateChannelsOpenWorkspace")}
              </Link>
            </Button>
          ) : null}
          <Button asChild>
            <Link href={PRIVATE_CHANNELS_SETUP_PATH}>
              {connected
                ? t("Shared.integrations.ctaManage")
                : t("Shared.integrations.ctaConfigure")}
            </Link>
          </Button>
        </div>
      </header>

      <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <h2 className="text-base font-medium text-primary">
          {t("Shared.integrations.detailAbout")}
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-pretty text-secondary">
          {t("Shared.integrations.privateChannelsDescription")}
        </p>
      </section>

      <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <h2 className="text-base font-medium text-primary">
          {t("Shared.integrations.rpcConnectionTitle")}
        </h2>
        {connected && instance.data ? (
          <dl className="mt-3 divide-y divide-border-subtle rounded-xl bg-fill-subtle px-4">
            <div className="flex flex-wrap justify-between gap-3 py-3 text-sm">
              <dt className="text-tertiary">{t("DashboardPrivateChannels.instance.gatewayUrl")}</dt>
              <dd className="break-all text-right text-secondary">{instance.data.gatewayUrl}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-3 py-3 text-sm">
              <dt className="text-tertiary">{t("DashboardPrivateChannels.events.columnStatus")}</dt>
              <dd className="text-secondary">{status}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm leading-6 text-secondary">
            {instance.ok
              ? t("Shared.integrations.privateChannelsConnectPrompt")
              : t("Shared.integrations.privateChannelsUnavailable")}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <h2 className="text-base font-medium text-primary">
          {t("Shared.integrations.detailResources")}
        </h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <Button asChild variant="secondary" size="sm">
            <Link href={`${PRIVATE_CHANNELS_OVERVIEW_PATH}?tab=playground`}>
              {t("DashboardPrivateChannels.tabs.apiPlayground")}
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
