// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

const motion = vi.hoisted(() => ({ reduced: false, inView: false }));

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
  useInView: () => motion.inView,
}));

import { STACK_PARTNERS } from "./stack/partners";
import { StackDrawing, type StackDrawingCopy } from "./stack/stack-drawing";
import { knobPosition, knobVisible, RECEIVED_AMOUNTS } from "./stack/stack-timeline";
import { StackSection } from "./stack-section";

const copy: StackDrawingCopy = {
  labels: { partners: "Partner APIs", sdp: "SDP", product: "Your product" },
  aria: { partners: "partners aria", sdp: "sdp aria", product: "product aria" },
  services: {
    custody: "Custody",
    compliance: "Compliance",
    ramps: "Ramps",
    nodes: "Nodes",
    wallets: "Wallets",
  },
  products: { wallet: "Wallet", checkout: "Checkout", payroll: "Payroll", treasury: "Treasury" },
  received: RECEIVED_AMOUNTS.map((amount) => `Received ${amount.toFixed(2)} USDC`),
};

beforeEach(() => {
  motion.reduced = false;
  motion.inView = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StackSection markup", () => {
  it("keeps its id and ground, and one h2 with the statement", async () => {
    const html = renderToStaticMarkup(await StackSection());
    const doc = new DOMParser().parseFromString(html, "text/html");
    const section = doc.querySelector("section#stack");
    expect(section?.getAttribute("data-ground")).toBe("paper");
    const headings = doc.querySelectorAll("h1, h2, h3");
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0].textContent).toContain("One integration across the stack");
  });

  it("describes each bubble as an image with its whole meaning", async () => {
    const doc = new DOMParser().parseFromString(
      renderToStaticMarkup(await StackSection()),
      "text/html"
    );
    const labels = [...doc.querySelectorAll('[role="img"]')].map((el) =>
      el.getAttribute("aria-label")
    );
    expect(labels).toEqual([
      "Partner APIs: custody, compliance, ramps, nodes, wallets",
      "SDP",
      "Your product: a wallet, checkout, payroll, treasury",
    ]);
  });

  it("lists every partner once for screen readers, with decorative marks", async () => {
    const doc = new DOMParser().parseFromString(
      renderToStaticMarkup(await StackSection()),
      "text/html"
    );
    const lists = doc.querySelectorAll("ul");
    expect(lists).toHaveLength(2);
    expect(lists[0].getAttribute("aria-label")).toBe("Partners on the platform");
    expect(lists[0].getAttribute("aria-hidden")).toBeNull();
    expect(lists[1].getAttribute("aria-hidden")).toBe("true");
    const names = [...lists[0].querySelectorAll("li")].map((li) => li.textContent);
    expect(names).toEqual(STACK_PARTNERS.map((partner) => partner.name));
    for (const img of lists[0].querySelectorAll("img")) expect(img.getAttribute("alt")).toBe("");
  });
});

describe("StackDrawing", () => {
  /* the drawing's hidden parts in order: the three labels, the track, the knob, the note */
  function decorations(container: HTMLElement) {
    return [
      ...(container.firstElementChild?.querySelectorAll<HTMLElement>(
        ':scope > [aria-hidden="true"]'
      ) ?? []),
    ];
  }

  it("renders the same markup with and without reduced motion, so hydration matches", () => {
    motion.reduced = false;
    const moving = renderToStaticMarkup(<StackDrawing copy={copy} />);
    motion.reduced = true;
    expect(renderToStaticMarkup(<StackDrawing copy={copy} />)).toBe(moving);
  });

  it("is a still picture under reduced motion: first words, the knob and note never shown", () => {
    motion.reduced = true;
    motion.inView = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame", "performance"] });
    const { container } = render(<StackDrawing copy={copy} />);
    act(() => vi.advanceTimersByTime(6000));
    const on = [...container.querySelectorAll("[data-on]")].map((el) => el.textContent);
    expect(on).toEqual(["Custody", "", "Wallet"]);
    const [, , , , knob, toast] = decorations(container);
    expect(knob?.hasAttribute("data-show")).toBe(false);
    expect(toast?.hasAttribute("data-up")).toBe(false);
  });

  it("reads each column once: the visible labels are hidden, the bubbles carry the words", () => {
    const { container } = render(<StackDrawing copy={copy} />);
    const labels = decorations(container).slice(0, 3);
    expect(labels.map((label) => label.textContent)).toEqual([
      "Partner APIs",
      "SDP",
      "Your product",
    ]);
  });

  it("sends the knob through SDP into the product once the drawing has landed", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "performance"],
    });
    motion.inView = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { container } = render(<StackDrawing copy={copy} />);
    const [, , , , knob, toast] = decorations(container);

    act(() => vi.advanceTimersByTime(900)); // the block lands; the route starts
    act(() => vi.advanceTimersByTime(420 + 1600));
    expect(knob?.dataset.tone).toBe("violet");
    expect(knob?.hasAttribute("data-show")).toBe(true);

    act(() => vi.advanceTimersByTime(1200));
    expect(knob?.dataset.tone).toBe("mint");
    expect(toast?.hasAttribute("data-up")).toBe(true);
    expect(toast?.textContent).toBe("Received 840.00 USDC");
  });
});

describe("stack timeline", () => {
  it("runs the knob from the services to the product", () => {
    expect(knobPosition(0)).toBe(17);
    expect(knobPosition(1500)).toBeCloseTo(50);
    expect(knobPosition(3000)).toBe(83);
    expect(knobPosition(9000)).toBe(83);
    expect(knobVisible(0)).toBe(false);
    expect(knobVisible(1500)).toBe(true);
    expect(knobVisible(2990)).toBe(false);
  });
});
