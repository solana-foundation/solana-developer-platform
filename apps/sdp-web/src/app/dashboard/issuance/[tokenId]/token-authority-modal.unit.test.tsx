import type { PaymentsDashboardWallet } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TokenAuthorityModal } from "./token-authority-modal";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

const wallets: PaymentsDashboardWallet[] = [
  { id: "cwlt_config", walletId: "provider_same", publicKey: "authority", label: "Config" },
  {
    id: "cwlt_connection",
    walletId: "provider_same",
    publicKey: "authority",
    label: "Connection",
  },
];

function render(signerWalletId: string): string {
  return renderToStaticMarkup(
    <TokenAuthorityModal
      row={{
        id: "mint-authority",
        title: "Mint authority",
        helper: "Can mint",
        value: "authority",
        authorityRole: "mint",
      }}
      currentAuthorityValue="authority"
      newAuthority="authority"
      authorityWallets={wallets}
      authorityWalletsError={null}
      signerWallets={wallets}
      signerWalletId={signerWalletId}
      signerUnavailableReason={null}
      isPending={false}
      onNewAuthorityChange={() => {}}
      onSignerWalletIdChange={() => {}}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  );
}

describe("TokenAuthorityModal", () => {
  it("requires an exact signer when authority rows are duplicated", () => {
    const markup = render("");
    const saveButton = markup.slice(markup.lastIndexOf("<button"));

    expect(markup).toContain("DashboardIssuance.signer.select");
    expect(saveButton).toContain("disabled");
  });

  it("allows the update after an exact signer is selected", () => {
    const markup = render("cwlt_connection");
    const saveButton = markup.slice(markup.lastIndexOf("<button"));

    expect(saveButton).not.toContain("disabled");
  });
});
