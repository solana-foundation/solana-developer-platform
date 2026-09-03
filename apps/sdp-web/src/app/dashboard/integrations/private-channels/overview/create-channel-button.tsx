"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { privateChannelCreatePath } from "../private-channels-routes";

export function CreateChannelButton({ instanceId }: { instanceId: string }) {
  const t = useTranslations();

  return (
    <Button asChild>
      <Link href={privateChannelCreatePath(instanceId)}>
        {t("DashboardPrivateChannels.directory.setupChannel")}
      </Link>
    </Button>
  );
}
