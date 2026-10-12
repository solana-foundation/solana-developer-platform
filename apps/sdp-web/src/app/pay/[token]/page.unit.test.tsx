// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PayPage from "./page";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));
vi.mock("../../dashboard/[projectId]/playground-api-data", () => ({
  resolvePlaygroundApiBaseUrl: () => "https://api.example.test",
}));
vi.mock("./pay-qr-code", () => ({
  PayQrCode: ({ url }: { url: string }) => (
    <div role="img" aria-label="Payment QR" data-url={url} />
  ),
}));

const publicToken = "original_public_token";
const savedPayUrl = `solana:${encodeURIComponent(`https://api.example.test/pay/${publicToken}`)}`;
const savedRequest = {
  amount: "17.25",
  tokenSymbol: "USDC",
  recipient: "11111111111111111111111111111111",
  status: "awaiting_payment",
  expiresAt: null,
  network: "devnet",
  solanaPayUrl: savedPayUrl,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Existing public payment links", () => {
  it("renders the original terms and sends the same URL to the QR and wallet link without a recipient pin", async () => {
    const fetch = vi.fn(async () => Response.json(savedRequest));
    vi.stubGlobal("fetch", fetch);

    render(await PayPage({ params: Promise.resolve({ token: publicToken }) }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`https://api.example.test/pay/${publicToken}`, {
      cache: "no-store",
    });
    expect(screen.getByText("17.25")).toBeTruthy();
    expect(screen.getAllByText("USDC")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Payment QR" }).getAttribute("data-url")).toBe(
      savedPayUrl
    );
    expect(screen.getByRole("link", { name: "Shared.pay.openWallet" }).getAttribute("href")).toBe(
      savedPayUrl
    );
  });

  it.each([
    { status: "paid", message: "Shared.pay.paymentReceived" },
    { status: "canceled", message: "Shared.pay.requestCanceled" },
    { status: "expired", message: "Shared.pay.linkExpired" },
  ])(
    "keeps the original $status link readable without offering a payment",
    async ({ status, message }) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ ...savedRequest, status, solanaPayUrl: null })
      );

      render(await PayPage({ params: Promise.resolve({ token: publicToken }) }));

      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.getByText("17.25")).toBeTruthy();
      expect(screen.queryByRole("img", { name: "Payment QR" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Shared.pay.openWallet" })).toBeNull();
    }
  );
});
