"use client";

import { Plus } from "lucide-react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

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
  const label = triggerLabel ?? t("DashboardCustody.createApiKey");

  return (
    <Button
      asChild
      size={triggerMode === "icon" ? "icon" : "default"}
      variant={triggerMode === "icon" ? "secondary" : triggerVariant}
    >
      <Link href="/dashboard/api-keys/new" aria-label={label}>
        {triggerMode === "icon" ? <Plus className="size-4" /> : label}
      </Link>
    </Button>
  );
}
