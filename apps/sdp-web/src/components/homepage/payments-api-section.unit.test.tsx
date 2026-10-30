// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { EnglishI18n } from "@/test/i18n";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { PaymentKindProvider } from "./payments/payment-kind-context";
import { PaymentsApiSection } from "./payments-api-section";

async function renderPaymentsApi() {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <EnglishI18n>
      <PaymentKindProvider>{await PaymentsApiSection()}</PaymentKindProvider>
    </EnglishI18n>
  );
  return container;
}

describe("PaymentsApiSection", () => {
  it("is the paper-ground #payments-api section with one h2", async () => {
    const view = await renderPaymentsApi();
    const section = view.querySelector("section");
    expect(section?.id).toBe("payments-api");
    expect(section?.dataset.ground).toBe("paper");
    const headings = view.querySelectorAll("h1, h2, h3");
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0].textContent).toContain("Stablecoins and fiat,");
    expect(headings[0].textContent).toContain("one payments API.");
  });

  it("opens the payment form in the sandbox, in the same tab", async () => {
    const view = await renderPaymentsApi();
    const link = [...view.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Send a payment in the sandbox")
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/payments/pay");
    expect(link?.hasAttribute("target")).toBe(false);
  });

  it("describes the bubble as one image", async () => {
    const view = await renderPaymentsApi();
    const bubble = view.querySelector('[role="img"]');
    expect(bubble?.getAttribute("aria-label")).toBe(
      "Payments of every kind, each one sent and settled"
    );
  });
});
