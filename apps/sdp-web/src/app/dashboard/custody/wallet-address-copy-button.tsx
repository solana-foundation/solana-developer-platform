"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";

interface WalletMetadataCopyButtonProps {
  value: string;
  label: string;
  tooltip?: string;
}

export function WalletMetadataCopyButton({ value, label, tooltip }: WalletMetadataCopyButtonProps) {
  const t = useTranslations();
  const copyLabel = label.toLowerCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("DashboardCustody.walletMetadataCopied", { label }));
    } catch {
      toast.error(t("DashboardCustody.unableToCopy", { label: copyLabel }));
    }
  };

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void handleCopy()}
      aria-label={t("DashboardCustody.copy", { label: copyLabel })}
      title={tooltip ? undefined : t("DashboardCustody.copy", { label: copyLabel })}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );

  if (!tooltip) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[32rem] break-all text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface WalletAddressCopyButtonProps {
  address: string;
  tooltip?: string;
}

export function WalletAddressCopyButton({ address, tooltip }: WalletAddressCopyButtonProps) {
  const t = useTranslations();
  return (
    <WalletMetadataCopyButton
      value={address}
      label={t("DashboardCustody.walletAddress")}
      tooltip={tooltip}
    />
  );
}
