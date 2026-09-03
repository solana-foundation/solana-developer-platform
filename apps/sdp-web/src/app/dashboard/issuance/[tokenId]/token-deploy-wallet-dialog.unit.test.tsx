import type { PaymentsDashboardWallet } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TokenDeployWalletDialog } from "./token-deploy-wallet-dialog";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

const wallets: PaymentsDashboardWallet[] = [
  { id: "cwlt_a", walletId: "provider_a", publicKey: "address_a", label: "Wallet A" },
  { id: "cwlt_b", walletId: "provider_b", publicKey: "address_b", label: "Wallet B" },
];

function render(signingCustodyWalletId: string): string {
  return renderToStaticMarkup(
    <TokenDeployWalletDialog
      isOpen
      isPending={false}
      signerWallets={wallets}
      signerUnavailableReason={null}
      signingCustodyWalletId={signingCustodyWalletId}
      onSigningCustodyWalletIdChange={() => {}}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  );
}

describe("TokenDeployWalletDialog", () => {
  it("blocks deployment until an exact wallet is selected", () => {
    const markup = render("");
    expect(markup).toContain("disabled");
  });

  it("allows deployment after an exact wallet is selected", () => {
    const markup = render("cwlt_b");
    const deployButton = markup.slice(markup.lastIndexOf("<button"));
    expect(deployButton).not.toContain("disabled");
  });
});
