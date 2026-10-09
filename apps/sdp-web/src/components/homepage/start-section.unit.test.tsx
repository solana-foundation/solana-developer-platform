// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey, type TranslationValues } from "@/i18n/messages";
import type { HomepageLinks } from "./homepage-links";

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

import { LoopGate } from "./start/loop-gate";
import { StartDoor } from "./start/start-door";
import { StartSection } from "./start-section";

const openLinks: HomepageLinks = {
  signup: { href: "/sign-up", label: "Create account", external: false },
  signIn: "/sign-in",
  docs: "https://docs.example/docs",
  openapi: "https://docs.example/docs/reference/api",
  llms: "https://docs.example/docs/ai/llms.txt",
};

const waitlistLinks: HomepageLinks = {
  ...openLinks,
  signup: { href: "https://waitlist.example/form", label: "Join the waitlist", external: true },
};

async function renderSection(links: HomepageLinks) {
  const html = renderToStaticMarkup(await StartSection({ links }));
  return new DOMParser().parseFromString(html, "text/html");
}

beforeEach(() => {
  motion.reduced = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StartSection markup", () => {
  it("keeps its id and night ground, with one h2 read as one sentence", async () => {
    const doc = await renderSection(openLinks);
    const section = doc.querySelector("section#start");
    expect(section?.getAttribute("data-ground")).toBe("night");
    const headings = doc.querySelectorAll("h1, h2, h3, h4");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.tagName).toBe("H2");
    expect(headings[0]?.querySelector(".sr-only")?.textContent).toBe(
      "Build the next wave of finance on Solana"
    );
  });

  it("hides the glass mark and the door's arrow from assistive technology", async () => {
    const doc = await renderSection(openLinks);
    const svgs = Array.from(doc.querySelectorAll("svg"));
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens sign-up in place as the sandbox, with the devnet note, while signup is open", async () => {
    const doc = await renderSection(openLinks);
    const door = doc.querySelector("a");
    expect(door?.getAttribute("href")).toBe("/sign-up");
    expect(door?.getAttribute("target")).toBeNull();
    expect(door?.textContent).toContain("Open the sandbox");
    expect(door?.textContent).toContain(getMessages("en").Homepage.start.doorNote);
  });

  it("opens the waitlist in a new tab as the sandbox, without the devnet note, while signup is closed", async () => {
    const doc = await renderSection(waitlistLinks);
    const door = doc.querySelector("a");
    expect(door?.getAttribute("href")).toBe("https://waitlist.example/form");
    expect(door?.getAttribute("target")).toBe("_blank");
    expect(door?.getAttribute("rel")).toBe("noreferrer");
    expect(door?.textContent).toBe("Open the sandbox");
  });

  it("starts with its loops paused", async () => {
    const doc = await renderSection(openLinks);
    expect(doc.querySelector("section#start")?.getAttribute("data-loops")).toBe("off");
  });
});

describe("LoopGate", () => {
  function stubObserver() {
    const observers: { callback: IntersectionObserverCallback }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      }
    );
    return (isIntersecting: boolean) =>
      act(() => {
        for (const observer of observers) {
          observer.callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver
          );
        }
      });
  }

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  afterEach(() => setVisibility("visible"));

  it("runs the loops only while near the screen and the tab is visible", () => {
    const intersect = stubObserver();
    const { container } = render(<LoopGate id="start" />);
    const section = container.querySelector("section");
    expect(section?.getAttribute("data-loops")).toBe("off");
    intersect(true);
    expect(section?.getAttribute("data-loops")).toBe("on");
    setVisibility("hidden");
    expect(section?.getAttribute("data-loops")).toBe("off");
    setVisibility("visible");
    expect(section?.getAttribute("data-loops")).toBe("on");
    intersect(false);
    expect(section?.getAttribute("data-loops")).toBe("off");
  });
});

describe("StartDoor", () => {
  function knobOf(container: HTMLElement) {
    const knob = container.querySelector<HTMLElement>("[data-knob]");
    if (!knob) throw new Error("no knob");
    return knob;
  }

  it("leans the knob toward a mouse and lets go when it leaves", () => {
    const { container } = render(<StartDoor signup={openLinks.signup} />);
    const door = container.querySelector("a") as HTMLAnchorElement;
    fireEvent.pointerMove(door, { pointerType: "mouse", clientX: 400, clientY: 0 });
    expect(door.style.getPropertyValue("--mx")).not.toBe("");
    expect(knobOf(container).style.getPropertyValue("--kx")).not.toBe("");
    fireEvent.pointerLeave(door);
    expect(knobOf(container).style.getPropertyValue("--kx")).toBe("");
  });

  it("keeps the knob still under reduced motion", () => {
    motion.reduced = true;
    const { container } = render(<StartDoor signup={openLinks.signup} />);
    const door = container.querySelector("a") as HTMLAnchorElement;
    fireEvent.pointerMove(door, { pointerType: "mouse", clientX: 400, clientY: 0 });
    expect(knobOf(container).style.getPropertyValue("--kx")).toBe("");
  });
});
