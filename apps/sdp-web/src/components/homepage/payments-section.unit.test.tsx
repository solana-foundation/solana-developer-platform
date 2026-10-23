// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
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
import { PaymentsSection } from "./payments-section";

async function renderPayments() {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <EnglishI18n>
      <PaymentKindProvider>
        <PaymentsSection />
      </PaymentKindProvider>
    </EnglishI18n>
  );
  return container;
}

describe("PaymentsSection", () => {
  it("is the paper-ground #payments section, the bench alone", async () => {
    const view = await renderPayments();
    const section = view.querySelector("section");
    expect(section?.id).toBe("payments");
    expect(section?.dataset.ground).toBe("paper");
    expect(view.querySelectorAll("h1, h2, h3")).toHaveLength(0);
    expect(view.querySelector('[role="img"]')).toBeNull();
  });

  it("names the six kinds as tabs that control one stage", async () => {
    const view = await renderPayments();
    const list = view.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toBe("Payment kinds");
    const tabs = [...view.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    /* each tab is named by its kind alone; its line of description is a description */
    const textOf = (id: string | null) =>
      id ? view.querySelector(`[id="${id}"]`)?.textContent : null;
    expect(tabs.map((tab) => textOf(tab.getAttribute("aria-labelledby")))).toEqual([
      "Pay",
      "Request",
      "Recurring",
      "Batch",
      "Micro",
      "Deposit",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    const panel = view.querySelector('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    for (const tab of tabs) expect(tab.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(textOf(tabs[0].getAttribute("aria-describedby"))).toBe(
      getMessages("en").Homepage.payments.kinds.pay.body
    );
    // the list is a column on a wide screen, a grid or a strip on smaller ones: no one orientation
    expect(list?.hasAttribute("aria-orientation")).toBe(false);
  });

  it("offers a real pause button for the walk", async () => {
    const view = await renderPayments();
    const pause = [...view.querySelectorAll("button")].find((b) => b.textContent === "Pause");
    expect(pause?.getAttribute("type")).toBe("button");
  });
});
