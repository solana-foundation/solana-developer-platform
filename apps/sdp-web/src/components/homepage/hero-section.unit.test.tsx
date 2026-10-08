// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";

function t(key: MessageKey, values?: TranslationValues) {
  return translate(getMessages("en"), key, values);
}

vi.mock("@/i18n/server", () => ({ getTranslations: async () => t }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => t }));

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

import { glideTarget, HeroGlide } from "./hero/hero-glide";
import { SDP_BUILDERS, SOLANA_BUILDERS } from "./hero/hero-logos";
import { HeroSection } from "./hero-section";
import type { HomepageLinks } from "./homepage-links";

const signupLinks: HomepageLinks = {
  signup: { href: "/sign-up", label: "Create account", external: false },
  signIn: "/sign-in",
  docs: "https://docs.example.test",
  openapi: "https://docs.example/docs/reference/api",
  llms: "https://docs.example/docs/ai/llms.txt",
};
const waitlistLinks: HomepageLinks = {
  ...signupLinks,
  signup: { href: "https://waitlist.example.test", label: "Join waitlist", external: true },
};

async function renderHero(links: HomepageLinks) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(await HeroSection({ links }));
  return container;
}

describe("HeroSection", () => {
  it("is the page's paper-ground first screen with its one h1", async () => {
    const hero = await renderHero(signupLinks);
    const root = hero.querySelector("header");
    expect(root?.id).toBe("top");
    expect(root?.dataset.ground).toBe("paper");
    const headings = hero.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0].querySelector(".sr-only")?.textContent).toBe(
      "The interface to onchain finance"
    );
  });

  it("forms the headline on the CSS clock from first paint, not after hydration", async () => {
    const h1 = (await renderHero(signupLinks)).querySelector("h1");
    expect(h1?.dataset.state).toBe("paint");
    expect(h1?.style.getPropertyValue("--form-start")).toBe("700ms");
    expect(h1?.querySelectorAll("[data-form-letter]").length).toBeGreaterThan(0);
  });

  it("opens sign-up in the same tab", async () => {
    const hero = await renderHero(signupLinks);
    const signup = [...hero.querySelectorAll("a")].find((a) => a.textContent === "Create account");
    expect(signup?.getAttribute("href")).toBe("/sign-up");
    expect(signup?.hasAttribute("target")).toBe(false);
  });

  it("opens the off-site waitlist in a new tab while signup is closed", async () => {
    const hero = await renderHero(waitlistLinks);
    const signup = [...hero.querySelectorAll("a")].find((a) => a.textContent === "Join waitlist");
    expect(signup?.getAttribute("href")).toBe("https://waitlist.example.test");
    expect(signup?.getAttribute("target")).toBe("_blank");
    expect(signup?.getAttribute("rel")).toBe("noreferrer");
  });

  it("links the docs", async () => {
    const hero = await renderHero(signupLinks);
    const docs = [...hero.querySelectorAll("a")].find((a) => a.textContent === "Read the docs");
    expect(docs?.getAttribute("href")).toBe("https://docs.example.test");
  });

  it("names every logo and labels the globe as one image", async () => {
    const hero = await renderHero(signupLinks);
    const alts = [...hero.querySelectorAll("img")].map((img) => img.getAttribute("alt"));
    expect(alts).toEqual([...SDP_BUILDERS, ...SOLANA_BUILDERS].map((logo) => logo.name));
    expect(hero.textContent).toContain("Building with SDP");
    expect(hero.textContent).toContain("Building on Solana");
    const globe = hero.querySelector('[role="img"]');
    expect(globe?.getAttribute("aria-label")).toBe("Payments crossing the network");
    expect(globe?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it("server-renders no globe canvas: three.js loads later, on the client", async () => {
    const hero = await renderHero(signupLinks);
    expect(hero.querySelector("canvas")).toBeNull();
    expect(hero.querySelector('[role="img"]')?.getAttribute("data-mode")).toBe("waiting");
  });
});

describe("glideTarget", () => {
  const landing = 800;

  it("glides on to the next section on the first steps down", () => {
    expect(glideTarget({ y: 100, down: true, landing })).toBe(landing);
  });

  it("leaves the first few pixels and the second half alone", () => {
    expect(glideTarget({ y: 10, down: true, landing })).toBeNull();
    expect(glideTarget({ y: 500, down: true, landing })).toBeNull();
  });

  it("glides back to the top on the way up", () => {
    expect(glideTarget({ y: 700, down: false, landing })).toBe(0);
    expect(glideTarget({ y: 300, down: false, landing })).toBeNull();
    expect(glideTarget({ y: 900, down: false, landing })).toBeNull();
  });
});

describe("HeroGlide", () => {
  afterEach(() => {
    cleanup();
    motion.reduced = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /* a one-screen hero with the next section 856px down, the page scrolled `y` */
  function mountGlide() {
    const hero = document.createElement("header");
    hero.id = "top";
    const next = document.createElement("section");
    next.id = "stack";
    document.body.append(hero, next);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    let y = 0;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => y);
    vi.spyOn(next, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({ y: 856 - y, height: 600, width: 1440 })
    );
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<HeroGlide heroId="top" nextId="stack" />);
    const scrollDown = () => {
      y = 100;
      window.dispatchEvent(new Event("scroll"));
    };
    return { scrollTo, scrollDown, cleanup: () => document.body.replaceChildren() };
  }

  it("glides on from a wheel scroll", () => {
    const glide = mountGlide();
    window.dispatchEvent(new Event("wheel"));
    glide.scrollDown();
    expect(glide.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
    glide.cleanup();
  });

  it("leaves a scroll by key, anchor or scrollbar where the reader sent it", () => {
    const glide = mountGlide();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    glide.scrollDown();
    expect(glide.scrollTo).not.toHaveBeenCalled();
    glide.cleanup();
  });

  it("never glides under reduced motion", () => {
    motion.reduced = true;
    const glide = mountGlide();
    window.dispatchEvent(new Event("wheel"));
    glide.scrollDown();
    expect(glide.scrollTo).not.toHaveBeenCalled();
    glide.cleanup();
  });
});
