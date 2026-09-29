// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WalletReceiveCard } from "./wallet-receive-card";

const mocks = vi.hoisted(() => ({
  toDataURL: vi.fn<(address: string, options?: unknown) => Promise<string>>(),
  toastSuccess: vi.fn(),
}));

vi.mock("qrcode", () => ({ default: { toDataURL: mocks.toDataURL } }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));

const ADDRESS = "ReceiveAddress11111111111111111111111111111111";
const QR_URL = "data:image/png;base64,cXItY29kZQ==";
const writeText = vi.fn<(value: string) => Promise<void>>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletReceiveCard", () => {
  it("shows the address and renders its QR code after generation", async () => {
    mocks.toDataURL.mockResolvedValue(QR_URL);

    render(<WalletReceiveCard address={ADDRESS} />, { wrapper });

    expect(screen.queryByText(ADDRESS)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeNull();
    expect(
      (await screen.findByRole("img", { name: "Wallet address QR code" })).getAttribute("src")
    ).toBe(QR_URL);
  });

  it("removes the QR loading state when generation fails", async () => {
    mocks.toDataURL.mockRejectedValue(new Error("QR generation failed"));
    const { container } = render(<WalletReceiveCard address={ADDRESS} />, { wrapper });

    await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeNull());
    expect(screen.queryByRole("img", { name: "Wallet address QR code" })).toBeNull();
  });

  it("copies the address and confirms it with a toast", async () => {
    mocks.toDataURL.mockResolvedValue(QR_URL);
    writeText.mockResolvedValue();
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<WalletReceiveCard address={ADDRESS} />, { wrapper });

    await user.click(screen.getByRole("button", { name: "Copy address" }));

    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Address copied.", {
      position: "bottom-right",
    });
  });
});
