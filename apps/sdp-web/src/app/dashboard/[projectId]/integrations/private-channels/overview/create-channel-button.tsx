"use client";

import { Button } from "@sdp/ui/button";
import Link from "next/link";
import { privateChannelCreatePath } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

export function CreateChannelButton({ instanceId }: { instanceId: string }) {
  const t = useTranslations();
  const href = useProjectHref();

  return (
    <Button asChild>
      <Link href={href(privateChannelCreatePath(instanceId))}>
        {t("DashboardPrivateChannels.directory.setupChannel")}
      </Link>
    </Button>
  );
}
