import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type WalletIdentity, WalletIdentityBadge } from "./wallet-identity";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

const managed: WalletIdentity = {
  state: "managed",
  name: "BYOK Test",
  provider: null,
  publicKey: "7xKq3vNfW2bYhK7sJdE3aGuP6nR7WcLm9tR8s9mPa",
  walletId: "wal_byok",
  restricted: false,
};

function render(identity: WalletIdentity, variant: "row" | "card"): string {
  return renderToStaticMarkup(
    <WalletIdentityBadge identity={identity} variant={variant} walletLink="new-tab" />
  );
}

describe("WalletIdentityBadge for a restricted managed wallet", () => {
  it("carries the restriction inside the row: warning mark, plain name, status in the detail line", () => {
    const markup = render({ ...managed, restricted: true }, "row");
    expect(markup).toContain("lucide-triangle-alert");
    expect(markup).toContain("DashboardCustody.signingDisabledTitle</span> · 7xKq3…9mPa");
    // The wallet is ours and active, so the name keeps its normal colour.
    expect(markup).toMatch(/<a [^>]*class="[^"]*text-primary[^"]*"[^>]*><span[^>]*>BYOK Test/);
    expect(markup).not.toMatch(/text-warning[^"]*"[^>]*>BYOK Test/);
  });

  it("shows nothing about signing when it is allowed", () => {
    const markup = render(managed, "row");
    expect(markup).not.toContain("lucide-triangle-alert");
    expect(markup).not.toContain("DashboardCustody.signingDisabledTitle");
  });

  it("puts the status under the name on the card", () => {
    const markup = render({ ...managed, restricted: true }, "card");
    expect(markup).toContain('data-testid="wallet-identity-card"');
    expect(markup).toContain("lucide-triangle-alert");
    expect(markup).toMatch(
      /<p class="[^"]*text-warning[^"]*">DashboardCustody\.signingDisabledTitle<\/p>/
    );
    const name = markup.indexOf("BYOK Test");
    const status = markup.indexOf("DashboardCustody.signingDisabledTitle");
    const keys = markup.indexOf("DashboardIssuance.wallet.walletId");
    expect(name).toBeLessThan(status);
    expect(status).toBeLessThan(keys);
  });
});
