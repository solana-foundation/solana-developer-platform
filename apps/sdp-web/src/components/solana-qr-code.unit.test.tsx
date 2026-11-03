// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SolanaQrCode } from "./solana-qr-code";

afterEach(() => {
  cleanup();
});

describe("SolanaQrCode", () => {
  it("holds the square with a skeleton until the code is drawn, never a blank box", async () => {
    const { container } = render(
      <SolanaQrCode url="https://example.test/pay/tok_1" size={208} label="Payment QR code" />
    );

    expect(container.querySelector(".animate-pulse")).not.toBeNull();

    const code = screen.getByRole("img", { name: "Payment QR code" });
    await waitFor(() => expect(code.querySelector("svg")).not.toBeNull());
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});
