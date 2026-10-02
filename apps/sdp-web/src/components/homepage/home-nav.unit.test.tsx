// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HomeNav } from "./home-nav";
import { type NavLink, navGroups } from "./homepage-links";

// Covered by its own tests; here it only needs to occupy its slot.
vi.mock("@/components/language-picker", () => ({ LanguagePicker: () => null }));

const createAccount: NavLink = { href: "/sign-up", label: "Homepage.nav.createAccount" };

const hrefs = {
  docs: "https://docs.test/docs",
  llms: "https://docs.test/docs/ai/llms.txt",
  openApi: "https://api.test/openapi.json",
  github: "https://github.test/sdp",
};
const groups = navGroups(hrefs, createAccount);

afterEach(cleanup);

function renderNav(primaryAction: NavLink = createAccount, signedIn = false) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <HomeNav
        groups={navGroups(hrefs, primaryAction)}
        primaryAction={primaryAction}
        signedIn={signedIn}
      />
    </I18nProvider>
  );
}

function bar() {
  return screen.getByRole("banner");
}

describe("HomeNav", () => {
  it("offers sign-in and account creation", () => {
    renderNav();

    expect(within(bar()).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/sign-in"
    );
    // The Docs panel carries the primary action too; every copy leads the same way.
    const createLinks = within(bar()).getAllByRole("link", { name: "Create account" });
    expect(createLinks.length).toBeGreaterThan(0);
    for (const link of createLinks) expect(link.getAttribute("href")).toBe("/sign-up");
  });

  it("offers the waitlist instead when signup is closed", () => {
    renderNav({ href: "https://waitlist.test", label: "Home.joinWaitlist", external: true });

    const waitlist = within(bar()).getAllByRole("link", { name: /Join the waitlist/ });
    expect(waitlist.length).toBeGreaterThan(0);
    for (const link of waitlist) expect(link.getAttribute("href")).toBe("https://waitlist.test");
    expect(within(bar()).queryByRole("link", { name: "Create account" })).toBeNull();
    expect(within(bar()).queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("offers only the dashboard to a signed-in visitor", () => {
    renderNav({ href: "/dashboard", label: "Homepage.nav.links.dashboard" }, true);

    expect(within(bar()).queryByRole("link", { name: "Sign in" })).toBeNull();
    // The Docs panel has its own "Dashboard" link; the action is the one to /dashboard.
    const dashboardLinks = within(bar()).getAllByRole("link", { name: "Dashboard" });
    expect(dashboardLinks.map((link) => link.getAttribute("href"))).toContain("/dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = document.getElementById(
      screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-controls") ?? ""
    ) as HTMLElement;
    const names = within(menu)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(names).not.toContain("Sign in");
    expect(names.at(-1)).toBe("Dashboard");
  });

  it("opens a group from its button and closes it on Escape, returning focus", () => {
    renderNav();
    const platform = within(bar()).getByRole("button", { name: "Platform" });

    expect(platform.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(platform);
    expect(platform.getAttribute("aria-expanded")).toBe("true");

    const panel = document.getElementById(platform.getAttribute("aria-controls") ?? "");
    expect(panel?.getAttribute("data-open")).toBe("true");
    expect(within(panel as HTMLElement).getByRole("link", { name: /Issuance/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(platform.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(platform);
  });

  it("does not open a group on focus alone", () => {
    renderNav();
    const docs = within(bar()).getByRole("button", { name: "Docs" });

    fireEvent.focus(docs);

    expect(docs.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes an open group on a click outside it", () => {
    renderNav();
    const builders = within(bar()).getByRole("button", { name: "Builders" });
    fireEvent.click(builders);

    fireEvent.pointerDown(document.body);

    expect(builders.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks links that open a new tab", () => {
    renderNav();
    fireEvent.click(within(bar()).getByRole("button", { name: "Docs" }));

    const openApi = within(bar()).getByRole("link", { name: /OpenAPI.*\(opens in a new tab\)/ });
    expect(openApi.getAttribute("href")).toBe("https://api.test/openapi.json");
    expect(openApi.getAttribute("target")).toBe("_blank");
  });

  it("keeps Tab inside the bar and the open mobile menu", () => {
    renderNav();
    const burger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(burger);
    const menu = document.getElementById(burger.getAttribute("aria-controls") ?? "") as HTMLElement;
    const links = within(menu).getAllByRole("link");
    const last = links[links.length - 1];
    const first = within(bar()).getByRole("link", { name: "SDP home" });

    last.focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Between the edges, Tab is left to the browser.
    links[0].focus();
    const tab = fireEvent.keyDown(links[0], { key: "Tab" });
    expect(tab).toBe(true);
    expect(document.activeElement).toBe(links[0]);
  });

  it("toggles the mobile menu, focuses its first link and closes on Escape", () => {
    renderNav();
    const burger = screen.getByRole("button", { name: "Open menu" });
    const menu = document.getElementById(burger.getAttribute("aria-controls") ?? "");
    expect(menu?.hidden).toBe(true);

    fireEvent.click(burger);

    expect(menu?.hidden).toBe(false);
    expect(burger.getAttribute("aria-expanded")).toBe("true");
    expect(burger.getAttribute("aria-label")).toBe("Close menu");
    expect(document.activeElement).toBe(menu?.querySelector("a"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(burger);
  });

  it("lists each destination once in the mobile menu, then sign-in and the primary action", () => {
    renderNav();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = document.getElementById(
      screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-controls") ?? ""
    ) as HTMLElement;

    const names = within(menu)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(-2)).toEqual(["Sign in", "Create account"]);
  });

  it("leaves the builders' film links out of the mobile menu", () => {
    renderNav();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = document.getElementById(
      screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-controls") ?? ""
    ) as HTMLElement;

    const hrefs = within(menu)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    const desktopOnly = groups.flatMap((group) =>
      group.columns.flat().filter((link) => link.desktopOnly)
    );
    expect(desktopOnly).toHaveLength(6);
    for (const link of desktopOnly) expect(hrefs).not.toContain(link.href);
  });
});
