// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey, type TranslationValues } from "@/i18n/messages";

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("@/i18n/provider", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    useLocale: () => "en",
    useTranslations: () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { PaymentsSection } from "./payments-section";

async function renderPayments() {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(await PaymentsSection());
  return container;
}

describe("PaymentsSection", () => {
  it("is the paper-ground #payments section with one h2", async () => {
    const view = await renderPayments();
    const section = view.querySelector("section");
    expect(section?.id).toBe("payments");
    expect(section?.dataset.ground).toBe("paper");
    const headings = view.querySelectorAll("h1, h2, h3");
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0].textContent).toContain("Stablecoins and fiat,");
    expect(headings[0].textContent).toContain("one payments API.");
  });

  it("opens the payment form in the sandbox, in the same tab", async () => {
    const view = await renderPayments();
    const link = [...view.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Send a payment in the sandbox")
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/payments/pay");
    expect(link?.hasAttribute("target")).toBe(false);
  });

  it("describes the bubble as one image", async () => {
    const view = await renderPayments();
    const bubble = view.querySelector('[role="img"]');
    expect(bubble?.getAttribute("aria-label")).toBe(
      "Payments of every kind, each one sent and settled"
    );
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
