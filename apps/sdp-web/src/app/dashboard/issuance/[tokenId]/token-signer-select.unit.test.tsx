import type { PaymentsDashboardWallet } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TokenSignerSelect } from "@/app/dashboard/issuance/[tokenId]/token-signer-select";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

function makeWallet(index: number): PaymentsDashboardWallet {
  return {
    id: `cw_${index}`,
    walletId: `wal_${index}`,
    publicKey: `PubKey${index}`,
    label: `Wallet ${index}`,
  };
}

function render(
  wallets: PaymentsDashboardWallet[],
  signerUnavailableReason: string | null = null
): string {
  return renderToStaticMarkup(
    <TokenSignerSelect
      signerWallets={wallets}
      signerWalletId=""
      signerUnavailableReason={signerUnavailableReason}
      onSignerWalletIdChange={() => {}}
      optional
    />
  );
}

describe("TokenSignerSelect", () => {
  it("locks to an identity card showing the only wallet, without a select", () => {
    const markup = render([makeWallet(1)]);
    expect(markup).toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("wal_1");
    expect(markup).toContain("PubKey1");
    expect(markup).not.toContain("DashboardIssuance.signer.select");
  });

  it("renders a select instead of a locked card when several wallets exist", () => {
    const markup = render([makeWallet(1), makeWallet(2)]);
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("DashboardIssuance.signer.select");
  });

  it("renders the optional-signer hint instead of a locked card when no wallets exist", () => {
    const markup = render([]);
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("DashboardIssuance.signer.defaultSignerHint");
  });

  it("surfaces the unavailable reason over the wallet list", () => {
    const markup = render([makeWallet(1)], "custody offline");
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("custody offline");
  });
});
