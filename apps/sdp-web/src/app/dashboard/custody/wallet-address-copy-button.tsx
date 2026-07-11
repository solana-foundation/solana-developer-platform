"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

interface WalletMetadataCopyButtonProps {
  value: string;
  label: string;
}

export function WalletMetadataCopyButton({ value, label }: WalletMetadataCopyButtonProps) {
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void handleCopy()}
      aria-label={t("DashboardCustody.copy", { label: copyLabel })}
      title={t("DashboardCustody.copy", { label: copyLabel })}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

interface WalletAddressCopyButtonProps {
  address: string;
}

export function WalletAddressCopyButton({ address }: WalletAddressCopyButtonProps) {
  const t = useTranslations();
  return <WalletMetadataCopyButton value={address} label={t("DashboardCustody.walletAddress")} />;
}
