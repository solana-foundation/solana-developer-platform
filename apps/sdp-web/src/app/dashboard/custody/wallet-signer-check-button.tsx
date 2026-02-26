"use client";

import { Button } from "@/components/ui/button";
import { useTransition } from "react";
import { toast } from "sonner";
import { checkWalletSignerMemoAction } from "./actions";

interface WalletSignerCheckButtonProps {
  walletId: string;
}

function getDevnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export function WalletSignerCheckButton({ walletId }: WalletSignerCheckButtonProps) {
  const [isChecking, startTransition] = useTransition();

  const runCheckRequest = async () => {
    const result = await checkWalletSignerMemoAction(walletId);

    if (result.status === "success") {
      const explorerUrl = getDevnetExplorerUrl(result.signature);

      toast.success("Signer check sent.", {
        description: (
          <span>
            Memo transaction submitted.{" "}
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              View on Solana Explorer
            </a>
          </span>
        ),
        position: "bottom-right",
      });
      return;
    }

    toast.error("Signer check failed.", {
      description: result.message,
      position: "bottom-right",
    });
  };

  const runCheck = () => {
    startTransition(() => {
      void runCheckRequest();
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isChecking}
      onClick={runCheck}
      aria-busy={isChecking}
    >
      {isChecking ? "Checking..." : "Check signer"}
    </Button>
  );
}
