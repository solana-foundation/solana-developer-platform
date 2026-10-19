"use client";

import { Button } from "@sdp/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

interface CreateApiKeyModalProps {
  triggerMode?: "button" | "icon";
  triggerLabel?: string;
  triggerVariant?: "default" | "secondary";
}

export function CreateApiKeyModal({
  triggerMode = "button",
  triggerLabel,
  triggerVariant = "default",
}: CreateApiKeyModalProps) {
  const t = useTranslations();
  const href = useProjectHref();
  const label = triggerLabel ?? t("DashboardCustody.createApiKey");

  return (
    <Button
      asChild
      size={triggerMode === "icon" ? "icon" : "default"}
      variant={triggerMode === "icon" ? "secondary" : triggerVariant}
    >
      <Link href={href("/dashboard/api-keys/new")} aria-label={label}>
        {triggerMode === "icon" ? <Plus className="size-4" /> : label}
      </Link>
    </Button>
  );
}
