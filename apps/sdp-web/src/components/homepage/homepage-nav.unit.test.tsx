// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("@/i18n/provider", () => ({ useLocale: () => "es" }));
vi.mock("@/components/language-picker", () => ({
  LanguagePicker: () => (
    <button type="button" aria-label="Language">
      A
    </button>
  ),
}));

import { getMessages, translate } from "@/i18n/messages";
import type { HomepageLinks } from "./homepage-links";
import { HomepageNav } from "./homepage-nav";
import { pickGround } from "./nav/use-nav-scroll";

const waitlistLinks: HomepageLinks = {
  signup: { href: "https://example.com/waitlist", label: "Join the waitlist", external: true },
  signIn: "/sign-in",
  docs: "https://docs.example/docs",
  openapi: "https://docs.example/docs/reference/api",
  llms: "https://docs.example/docs/ai/llms.txt",
};

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);

const openLinks: HomepageLinks = {
  ...waitlistLinks,
  signup: { href: "/sign-up", label: "Create account", external: false },
};

async function renderNav(links: HomepageLinks) {
  render(await HomepageNav({ links }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  document.documentElement.style.overflow = "";
});

describe("HomepageNav", () => {
  it("renders the landmarks, the skip link and the account links", async () => {
    await renderNav(openLinks);

    expect(screen.getByRole("link", { name: t("Homepage.nav.skip") })).toHaveProperty(
      "hash",
      "#main"
    );
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: t("Homepage.nav.primary") })).toBeTruthy();
    expect(screen.getByRole("link", { name: t("Homepage.nav.home") }).getAttribute("href")).toBe(
      "/"
    );

    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: "Language" })).toBeTruthy();
    expect(
      within(banner)
        .getByRole("link", { name: t("Homepage.cta.signIn") })
        .getAttribute("href")
    ).toBe("/sign-in");
    const signup = within(banner).getByRole("link", { name: "Create account" });
    expect(signup.getAttribute("href")).toBe("/sign-up");
    expect(signup.getAttribute("target")).toBeNull();
  });

  it("opens the waitlist in a new tab while signup is closed", async () => {
    await renderNav(waitlistLinks);

    const signup = within(screen.getByRole("banner")).getByRole("link", {
      name: "Join the waitlist",
    });
    expect(signup.getAttribute("href")).toBe("https://example.com/waitlist");
    expect(signup.getAttribute("target")).toBe("_blank");
    expect(signup.getAttribute("rel")).toBe("noreferrer");
  });

  it("shows only the dashboard link to a signed-in visitor", async () => {
    await renderNav({
      ...openLinks,
      signup: { href: "/dashboard", label: "Dashboard", external: false },
      signIn: "/dashboard",
      signedIn: true,
    });

    const banner = screen.getByRole("banner");
    expect(within(banner).queryByRole("link", { name: t("Homepage.cta.signIn") })).toBeNull();
    expect(within(banner).queryByRole("link", { name: "Create account" })).toBeNull();
    // the account action and the docs panel's Dashboard link
    const dashboards = within(banner).getAllByRole("link", { name: "Dashboard" });
    expect(dashboards).toHaveLength(2);
    for (const link of dashboards) {
      expect(link.getAttribute("href")).toBe("/dashboard");
      expect(link.getAttribute("target")).toBeNull();
    }
  });

  it("points the panels at the in-page sections and the docs", async () => {
    const { container } = render(await HomepageNav({ links: openLinks }));
    const hrefs = (id: string) =>
      Array.from(container.querySelectorAll(`#${id} a`)).map((a) => a.getAttribute("href"));

    expect(hrefs("homepage-nav-platform")).toEqual([
      "#issuance",
      "#payments",
      "#markets",
      "#privacy",
      "#stack",
      "#interfaces",
      "#network",
      "/sign-up",
    ]);
    expect(hrefs("homepage-nav-builders").slice(0, 3)).toEqual(["#builders", "#blog", "#stack"]);
    const docs = hrefs("homepage-nav-docs");
    expect(docs.slice(0, 3)).toEqual([openLinks.docs, openLinks.openapi, openLinks.llms]);
    expect(docs).toContain("/sign-in");
  });

  it("opens the builders' films in a new tab and says so", async () => {
    const { container } = render(await HomepageNav({ links: openLinks }));
    const films = Array.from(container.querySelectorAll("#homepage-nav-builders a")).slice(3);

    expect(films.map((a) => a.textContent)).toEqual([
      "Fireblocks",
      "Helius",
      "Alchemy",
      "Coinbase",
      "BitGo",
      t("Homepage.nav.builders.series"),
    ]);
    for (const film of films) {
      expect(film.getAttribute("target")).toBe("_blank");
      expect(film.getAttribute("rel")).toBe("noreferrer");
      expect(film.getAttribute("aria-label")).toMatch(/\(opens in a new tab\)$/);
      // the accessible name starts with the visible label (WCAG 2.5.3)
      expect(film.getAttribute("aria-label")?.startsWith(film.textContent ?? "")).toBe(true);
    }
    expect(films[0]?.getAttribute("href")).toBe("https://www.youtube.com/watch?v=ZfUtJgkE5dE");
  });

  it("opens a panel from its trigger, not from focus, and returns focus to it on Escape", async () => {
    await renderNav(openLinks);
    const trigger = screen.getByRole("button", { name: t("Homepage.nav.docs.label") });
    expect(trigger.getAttribute("aria-controls")).toBe("homepage-nav-docs");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Tab reaching the trigger leaves the panel shut, so the next Tab moves on through the bar.
    act(() => trigger.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const panelLink = screen.getByRole("link", { name: t("Homepage.nav.docs.execute") });
    act(() => panelLink.focus());
    fireEvent.keyDown(panelLink, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the open panel when focus moves on to the next trigger", async () => {
    await renderNav(openLinks);
    const platform = screen.getByRole("button", { name: t("Homepage.nav.platform.label") });
    const builders = screen.getByRole("button", { name: t("Homepage.nav.builders.label") });

    act(() => platform.focus());
    fireEvent.click(platform);
    expect(platform.getAttribute("aria-expanded")).toBe("true");

    act(() => builders.focus());
    expect(platform.getAttribute("aria-expanded")).toBe("false");
    expect(builders.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the phone menu with focus inside, locks scroll and closes back to the burger", async () => {
    await renderNav(openLinks);
    const burger = screen.getByRole("button", { name: t("Homepage.nav.openMenu") });
    expect(burger.getAttribute("aria-controls")).toBe("homepage-mobile-menu");

    fireEvent.click(burger);
    expect(burger.getAttribute("aria-expanded")).toBe("true");
    expect(burger.getAttribute("aria-label")).toBe(t("Homepage.nav.closeMenu"));
    const menu = screen.getByRole("navigation", { name: t("Homepage.nav.menu") });
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(burger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(burger);
    expect(document.documentElement.style.overflow).toBe("");

    fireEvent.click(burger);
    fireEvent.click(within(menu).getByRole("link", { name: t("Homepage.nav.mobile.builders") }));
    expect(burger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(burger);
  });
});

describe("pickGround", () => {
  function section(ground: string | null, top: number, bottom: number) {
    const el = document.createElement("section");
    if (ground) el.setAttribute("data-ground", ground);
    el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    document.body.append(el);
  }

  it("takes the ground of the section under the line", () => {
    section("paper", -500, 100);
    section("night", 100, 900);
    expect(pickGround(null, 500)).toBe("night");
    expect(pickGround(null, 50)).toBe("paper");
  });

  it("counts a section without the mark as paper", () => {
    section(null, 0, 900);
    expect(pickGround(null, 500)).toBe("paper");
  });
});
