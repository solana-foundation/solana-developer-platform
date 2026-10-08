"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { privateChannelCreatePath } from "../private-channels-routes";

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
