// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import PayPage from "./page";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));
vi.mock("@/app/dashboard/[projectId]/playground-api-data", () => ({
  resolvePlaygroundApiBaseUrl: () => "https://api.example.test",
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
  it("renders the original terms and QR for the saved wallet URL without a recipient pin", async () => {
    const fetch = vi.fn(async () => Response.json(savedRequest));
    vi.stubGlobal("fetch", fetch);

    // jsdom does not load the embedded 16×14 logo; only its browser image boundary is simulated.
    class LoadedLogo extends Image {
      constructor() {
        super(16, 14);
        queueMicrotask(() => this.dispatchEvent(new Event("load")));
      }
    }
    vi.stubGlobal("Image", LoadedLogo);
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        {await PayPage({ params: Promise.resolve({ token: publicToken }) })}
      </I18nProvider>
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`https://api.example.test/pay/${publicToken}`, {
      cache: "no-store",
    });
    expect(screen.getByText("17.25")).toBeTruthy();
    expect(screen.getAllByText("USDC")).toHaveLength(2);
    const qr = screen.getByRole("img", { name: "Solana Pay QR code" });
    await waitFor(() => {
      expect(qr.querySelectorAll("svg defs > [id^=clip-path]")).toHaveLength(7);
    });
    // Geometry for the saved URL, independently decoded once; renderer instance IDs are excluded.
    const geometry = Array.from(
      qr.querySelectorAll("svg defs > [id^=clip-path]"),
      (part) => part.innerHTML
    ).join("");
    expect(createHash("sha256").update(geometry).digest("hex")).toBe(
      "30b13227de1b450382e39ef7427a8bee327609de9a350ace53f5f838abb3520f"
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
      expect(screen.queryByRole("img", { name: "Solana Pay QR code" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Shared.pay.openWallet" })).toBeNull();
    }
  );
});
