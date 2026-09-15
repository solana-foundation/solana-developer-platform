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
    isRuntimeExecutionAllowed: true,
    publicKey: `PubKey${index}`,
    label: `Wallet ${index}`,
  };
}

function render(
  wallets: PaymentsDashboardWallet[],
  signerUnavailableReason: string | null = null,
  signerWalletId = ""
): string {
  return renderToStaticMarkup(
    <TokenSignerSelect
      signerWallets={wallets}
      signerWalletId={signerWalletId}
      signerUnavailableReason={signerUnavailableReason}
      onSignerWalletIdChange={() => {}}
      optional
    />
  );
}

describe("TokenSignerSelect", () => {
  it("shows runtime unavailability for signing, while the same wallet remains usable in a draft", () => {
    const wallet = { ...makeWallet(1), isRuntimeExecutionAllowed: false };
    const markup = renderToStaticMarkup(
      <TokenSignerSelect
        signerWallets={[wallet]}
        signerWalletId={wallet.id}
        signerUnavailableReason={null}
        onSignerWalletIdChange={() => {}}
      />
    );
    expect(markup).toContain("Wallet 1");
    // The locked row carries the restriction itself; no sentence repeats it below.
    expect(markup).toContain("DashboardCustody.signingDisabledTitle");
    expect(markup).not.toContain("DashboardIssuance.management.signingUnavailable");
    expect(markup).toContain("text-warning");
    expect(markup).not.toContain("text-destructive-strong");
    const draftMarkup = render([wallet], null, wallet.id);
    expect(draftMarkup).toContain("Wallet 1");
    expect(draftMarkup).not.toContain("DashboardIssuance.management.signingUnavailable");
  });

  it("shows the only wallet as a compact identity row without a select", () => {
    const markup = render([makeWallet(1)]);
    expect(markup).toContain('href="/dashboard/wallets/wal_1"');
    expect(markup).toContain("Wallet 1");
    expect(markup).toContain("wal_1");
    expect(markup).toContain("PubKey1");
    expect(markup).not.toContain("DashboardIssuance.signer.select");
  });

  it("renders a select instead of a locked card when several wallets exist", () => {
    const markup = render([makeWallet(1), makeWallet(2)]);
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("DashboardIssuance.signer.select");
  });

  it("keeps selection available when a previous choice disappeared and only one wallet remains", () => {
    const markup = render([makeWallet(1)], null, "cw_removed");
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("DashboardIssuance.signer.select");
  });

  it("renders the optional-signer hint instead of a locked card when no wallets exist", () => {
    const markup = render([]);
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("DashboardIssuance.signer.defaultSignerHint");
  });

  it("keeps the identity row for a single signer whose runtime signing is restricted", () => {
    const wallet = { ...makeWallet(1), isRuntimeExecutionAllowed: false };
    const markup = renderToStaticMarkup(
      <TokenSignerSelect
        signerWallets={[wallet]}
        signerWalletId={wallet.id}
        signerUnavailableReason="DashboardIssuance.management.signingUnavailable"
        onSignerWalletIdChange={() => {}}
      />
    );
    expect(markup).toContain('href="/dashboard/wallets/wal_1"');
    expect(markup).not.toContain("DashboardIssuance.signer.select");
    // Status once, inside the row; the runtime sentence is not repeated under it.
    expect(markup.split("DashboardCustody.signingDisabledTitle")).toHaveLength(2);
    expect(markup).not.toContain("DashboardIssuance.management.signingUnavailable");
  });

  it("lets the selection summary carry a restricted pick among several wallets", () => {
    const restricted = { ...makeWallet(2), isRuntimeExecutionAllowed: false };
    const markup = renderToStaticMarkup(
      <TokenSignerSelect
        signerWallets={[makeWallet(1), restricted]}
        signerWalletId={restricted.id}
        signerUnavailableReason={null}
        onSignerWalletIdChange={() => {}}
        showSelectionSummary
      />
    );
    // Still the select branch, not a locked row.
    expect(markup).toContain('role="combobox"');
    expect(markup.split("DashboardCustody.signingDisabledTitle")).toHaveLength(2);
    expect(markup).not.toContain("DashboardIssuance.management.signingUnavailable");
  });

  it("still shows an explicit helper under a locked row", () => {
    const markup = renderToStaticMarkup(
      <TokenSignerSelect
        signerWallets={[makeWallet(1)]}
        signerWalletId="cw_1"
        signerUnavailableReason={null}
        helperText="custom helper"
        onSignerWalletIdChange={() => {}}
      />
    );
    expect(markup).toContain("custom helper");
  });

  it("surfaces the unavailable reason over the wallet list", () => {
    const markup = render([makeWallet(1)], "custody offline");
    expect(markup).not.toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("custody offline");
    expect(markup).toContain("text-destructive-strong");
    expect(markup).not.toContain("text-warning");
  });
});
