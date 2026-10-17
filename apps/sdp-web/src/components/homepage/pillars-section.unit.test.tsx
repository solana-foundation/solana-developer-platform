// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

const motion = vi.hoisted(() => ({ reduced: false }));

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
}));

import { PillarBubble } from "./pillars/pillar-bubble";
import { PillarsSection } from "./pillars-section";

let observerCallback: IntersectionObserverCallback | undefined;
let observed = 0;

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe() {
    observed += 1;
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function setOnScreen(isIntersecting: boolean) {
  act(() => {
    observerCallback?.(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  motion.reduced = false;
  observerCallback = undefined;
  observed = 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  // narrow: no page-order stagger, so the gesture starts as soon as the block has landed
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PillarsSection", () => {
  it("renders the head, three pillars and their links on the paper ground", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(await PillarsSection());

    const section = container.querySelector("section");
    expect(section?.id).toBe("pillars");
    expect(section?.getAttribute("data-ground")).toBe("paper");

    expect(container.querySelector("h2")?.textContent).toContain("Issue it. Move it. Earn on it.");
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Issuance",
      "Payments",
      "Markets",
    ]);

    const pictures = [...container.querySelectorAll('[role="img"]')];
    expect(pictures.map((p) => p.getAttribute("aria-label"))).toEqual([
      "An asset being minted",
      "A payment moving",
      "Two legs of a trade settling together",
    ]);

    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Issue the asset", "#issuance"],
      ["Move the money", "#payments"],
      ["Earn on it", "#markets"],
    ]);
    for (const link of links) {
      expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("PillarBubble", () => {
  it("stays still under reduced motion", () => {
    motion.reduced = true;
    vi.useFakeTimers();
    const { getByRole } = render(<PillarBubble kind="send" label="A payment moving" order={0} />);
    advance(5000);

    const bubble = getByRole("img", { name: "A payment moving" });
    expect(observed).toBe(0);
    expect(bubble.hasAttribute("data-on")).toBe(false);
    expect(bubble.hasAttribute("data-beat")).toBe(false);
  });

  it("plays its gesture once landed and on screen, and pauses off screen", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    const { getByRole } = render(<PillarBubble kind="send" label="A payment moving" order={0} />);
    const bubble = getByRole("img", { name: "A payment moving" });

    setOnScreen(true);
    advance(900 + 800);
    expect(bubble.hasAttribute("data-on")).toBe(true);
    expect(bubble.hasAttribute("data-beat")).toBe(true);
    expect(bubble.hasAttribute("data-paused")).toBe(false);

    advance(1200);
    expect(bubble.hasAttribute("data-rs")).toBe(true);
    advance(300);
    expect(bubble.hasAttribute("data-on")).toBe(false);

    setOnScreen(false);
    expect(bubble.hasAttribute("data-paused")).toBe(true);
  });

  it("turns the markets orbit half a turn per gesture", () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    const { getByRole } = render(<PillarBubble kind="swap" label="Two legs" order={2} />);
    const orb = getByRole("img", { name: "Two legs" }).querySelector(
      "[aria-hidden]"
    ) as HTMLElement;

    setOnScreen(true);
    advance(900 + 800);
    expect(orb.style.transform).toBe("rotate(180deg)");
    advance(2800);
    expect(orb.style.transform).toBe("rotate(360deg)");
  });
});
