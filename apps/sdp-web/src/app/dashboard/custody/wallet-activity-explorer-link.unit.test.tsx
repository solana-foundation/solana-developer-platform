import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WalletActivityPayload } from "@/app/dashboard/custody/wallet-activity.data";

const SIGNATURE = "5peZpyva3RvEdVZoCzzetHhGetN6AEHGLqtvrfExampleSignature";

const activity: WalletActivityPayload = {
  activityRows: [
    {
      id: "payment-1",
      sourceKind: "payments",
      operationLabel: "Outgoing",
      status: "confirmed",
      signature: SIGNATURE,
      token: "SOL",
      amount: "0.5",
      address: "6t4B1TVgSjnAM9h5MpahLhGc9MtWFTGmcaPsy9JGskoV",
      createdAt: "2026-07-23T22:55:00.000Z",
    },
  ],
  activityError: null,
  activityNotice: null,
};

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("swr", () => ({
  default: () => ({ data: activity, error: undefined, isValidating: false, mutate: vi.fn() }),
}));

vi.mock("@/app/dashboard/custody/wallet-activity.data", () => ({
  fetchWalletActivity: vi.fn(),
}));

// The cluster comes from the active project. Stubbing the hook is the point of the
// test: the component must read the href cluster from here rather than pinning one.
const cluster = vi.hoisted(() => ({ value: "mainnet-beta" }));
vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => cluster.value,
}));

import { WalletActivitySection } from "./wallet-activity-section";

describe("WalletActivitySection explorer links", () => {
  it("points the signature at mainnet explorer for a production project", () => {
    cluster.value = "mainnet-beta";

    const markup = renderToStaticMarkup(<WalletActivitySection walletId="wallet-one" />);

    expect(markup).toContain(`https://explorer.solana.com/tx/${SIGNATURE}`);
    // Regression guard: this link was hardcoded to devnet, which is wrong on a
    // production project. Mainnet is Explorer's default, so it carries no query.
    expect(markup).not.toContain("cluster=devnet");
  });

  it("keeps the devnet query for a sandbox project", () => {
    cluster.value = "devnet";

    const markup = renderToStaticMarkup(<WalletActivitySection walletId="wallet-one" />);

    expect(markup).toContain(`https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`);
  });
});
