// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { NetworkSection } from "./network-section";
import { PaymentsSection } from "./payments-section";

vi.mock("motion/react", () => ({
  useInView: () => false,
  useReducedMotion: () => false,
}));

// The drawing is canvas work; here each mounted picture reports one settlement at once.
vi.mock("./scenes/speed/draw-speed", async (importOriginal) => {
  const original = await importOriginal<typeof import("./scenes/speed/draw-speed")>();
  return {
    ...original,
    mountSpeed: (
      _host: HTMLElement,
      _canvas: HTMLCanvasElement,
      options: { onSettle: () => void }
    ) => {
      options.onSettle();
      return () => {};
    },
  };
});

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);

afterEach(cleanup);

function inI18n(children: React.ReactNode) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

describe("NetworkSection", () => {
  it("is a night band the bar can find", () => {
    const { container } = inI18n(<NetworkSection t={t} />);

    expect(container.querySelector("#network")?.getAttribute("data-ground")).toBe("night");
    expect(
      screen.getByRole("heading", { level: 2, name: "Settled everywhere, under a second." })
    ).toBeTruthy();
  });

  it("describes the rails as one image and lists a settled payment", () => {
    inI18n(<NetworkSection t={t} />);
    const picture = screen.getByRole("img", {
      name: "The same payment on four rails: Solana settles in under a second while the others take days",
    });

    for (const lane of ["Solana, via SDP", "Card networks", "ACH", "SWIFT"]) {
      expect(within(picture).getByText(lane)).toBeTruthy();
    }
    expect(within(picture).getByText("Settled on Solana")).toBeTruthy();
    expect(within(picture).getByText(/^slot \d/)).toBeTruthy();
  });

  it("gives every figure its final value, whatever the count-up is showing", () => {
    const { container } = inI18n(<NetworkSection t={t} />);

    const finals = Array.from(container.querySelectorAll(".sr-only")).map(
      (node) => node.textContent
    );
    expect(finals).toEqual(expect.arrayContaining(["30+", "200+", "1"]));
    expect(screen.getByText("<1 s")).toBeTruthy();
  });
});

describe("PaymentsSection", () => {
  const sandbox = { href: "/sign-up", label: "Homepage.nav.createAccount" } as const;

  it("shows one payment settling and the six ways to move money", () => {
    inI18n(<PaymentsSection t={t} sandbox={sandbox} />);

    const picture = screen.getByRole("img", {
      name: "One payment, treasury to supplier, settled in under a second",
    });
    expect(within(picture).getByText(/^Confirmed · slot \d/)).toBeTruthy();
    for (const mode of ["Pay", "Request", "Recurring", "Batch", "Micro", "Deposit"]) {
      expect(screen.getByText(mode)).toBeTruthy();
    }
  });

  it("leads into the sandbox", () => {
    inI18n(<PaymentsSection t={t} sandbox={sandbox} />);

    expect(
      screen.getByRole("link", { name: "Send a payment in the sandbox" }).getAttribute("href")
    ).toBe("/sign-up");
  });
});
