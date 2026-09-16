import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TokenDeployWalletDialog } from "./token-deploy-wallet-dialog";
import { getSignerSelectionForAction } from "./token-management-workspace.utils";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

const wallets: PaymentsDashboardWallet[] = [
  {
    id: "cwlt_a",
    walletId: "provider_a",
    isRuntimeExecutionAllowed: true,
    publicKey: "address_a",
    label: "Wallet A",
  },
  {
    id: "cwlt_b",
    walletId: "provider_b",
    isRuntimeExecutionAllowed: true,
    publicKey: "address_b",
    label: "Wallet B",
  },
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
  it("allows an explicit replacement while keeping a runtime-unavailable saved choice as the default", () => {
    const inventory = wallets.map((wallet) => ({
      ...wallet,
      isRuntimeExecutionAllowed: wallet.id === "cwlt_b",
    }));
    const selection = getSignerSelectionForAction({
      action: "deploy",
      token: { status: "pending", signingCustodyWalletId: "cwlt_a" } as Token,
      authorityWallets: inventory,
      metadataAuthority: null,
      t: (key) => key,
    });
    const buttonMarkup = (walletId: string) => {
      const markup = renderToStaticMarkup(
        <TokenDeployWalletDialog
          isOpen
          isPending={false}
          signerWallets={selection.wallets}
          signerUnavailableReason={selection.unavailableReason}
          signingCustodyWalletId={walletId}
          onSigningCustodyWalletIdChange={() => {}}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      );
      return markup.slice(markup.lastIndexOf("<button"));
    };
    expect(selection.defaultWalletId).toBe("cwlt_a");
    expect(buttonMarkup("cwlt_a")).toContain("disabled");
    expect(buttonMarkup("cwlt_b")).not.toContain("disabled");
    expect(buttonMarkup("cwlt_missing")).toContain("disabled");
  });

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
