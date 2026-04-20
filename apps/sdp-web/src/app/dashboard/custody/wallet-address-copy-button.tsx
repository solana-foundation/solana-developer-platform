"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface WalletAddressCopyButtonProps {
  address: string;
}

export function WalletAddressCopyButton({ address }: WalletAddressCopyButtonProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Wallet address copied.");
    } catch {
      toast.error("Unable to copy wallet address.");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void handleCopy()}
      aria-label="Copy wallet address"
      title="Copy wallet address"
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}
