"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface WalletMetadataCopyButtonProps {
  value: string;
  label: string;
}

export function WalletMetadataCopyButton({ value, label }: WalletMetadataCopyButtonProps) {
  const copyLabel = label.toLowerCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Unable to copy ${copyLabel}.`);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void handleCopy()}
      aria-label={`Copy ${copyLabel}`}
      title={`Copy ${copyLabel}`}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

interface WalletAddressCopyButtonProps {
  address: string;
}

export function WalletAddressCopyButton({ address }: WalletAddressCopyButtonProps) {
  return <WalletMetadataCopyButton value={address} label="Wallet address" />;
}
