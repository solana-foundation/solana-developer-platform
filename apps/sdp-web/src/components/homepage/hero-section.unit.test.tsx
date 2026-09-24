// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HeroSection } from "./hero-section";
import { homepagePrimaryAction } from "./homepage-links";

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("motion/react", () => ({ useReducedMotion: () => motion.reduced }));
// The globe has its own tests; here it only needs to occupy its slot.
vi.mock("./homepage-globe", () => ({ HomepageGlobe: () => null }));

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);

beforeEach(() => {
  vi.useFakeTimers();
  motion.reduced = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHero(openSignup = true) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      <HeroSection
        t={t}
        docsHref="https://docs.test/docs"
        primaryAction={homepagePrimaryAction({ openSignup, signedIn: false })}
      />
    </I18nProvider>
  );
}

function hero() {
  return document.getElementById("top") as HTMLElement;
}

describe("HeroSection", () => {
  it("names the heading with the whole sentence, not the drawn letters", () => {
    renderHero();

    expect(
      screen.getByRole("heading", { level: 1, name: "The interface to onchain finance" })
    ).toBeTruthy();
  });

  it("links the docs and account creation", () => {
    renderHero();

    expect(screen.getByRole("link", { name: "Read the docs" }).getAttribute("href")).toBe(
      "https://docs.test/docs"
    );
    expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
      "/sign-up"
    );
  });

  it("offers the waitlist instead when signup is closed", () => {
    renderHero(false);

    expect(screen.getByRole("link", { name: /Join the waitlist/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });

  it("names every logo in the bar", () => {
    renderHero();

    const names = screen.getAllByRole("img").map((image) => image.getAttribute("alt"));
    expect(names).toEqual([
      "Mastercard",
      "Western Union",
      "Worldpay",
      "PayPal",
      "Visa",
      "DTCC",
      "State Street",
    ]);
  });

  it("marks each arrival step in order", () => {
    renderHero();
    expect(hero().hasAttribute("data-w1")).toBe(false);

    act(() => vi.advanceTimersByTime(400));
    expect(hero().hasAttribute("data-w1")).toBe(true);
    expect(hero().hasAttribute("data-w2")).toBe(false);

    act(() => vi.advanceTimersByTime(3000));
    for (const mark of ["data-w2", "data-tail", "data-sel1", "data-sel2"]) {
      expect(hero().hasAttribute(mark)).toBe(true);
    }
  });

  it("sets every step at once under reduced motion", () => {
    motion.reduced = true;
    renderHero();
    act(() => vi.runOnlyPendingTimers());

    for (const mark of ["data-w1", "data-w2", "data-tail", "data-sel1", "data-sel2"]) {
      expect(hero().hasAttribute(mark)).toBe(true);
    }
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("data-form")).toBe("solid");
  });
});
