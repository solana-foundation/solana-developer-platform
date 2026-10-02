import { describe, expect, it } from "vitest";
import { CONTACT_HREF, homepagePrimaryAction, navGroups } from "./homepage-links";

describe("homepagePrimaryAction", () => {
  it("offers account creation when open signup is enabled", () => {
    expect(homepagePrimaryAction({ openSignup: true, signedIn: false })).toEqual({
      href: "/sign-up",
      label: "Homepage.nav.createAccount",
    });
  });

  it("offers only the waitlist when open signup is disabled", () => {
    expect(homepagePrimaryAction({ openSignup: false, signedIn: false })).toEqual({
      href: CONTACT_HREF,
      label: "Home.joinWaitlist",
      external: true,
    });
  });
});

describe("homepagePrimaryAction for a signed-in visitor", () => {
  it("leads to the dashboard, whether or not signup is open", () => {
    for (const openSignup of [true, false]) {
      expect(homepagePrimaryAction({ openSignup, signedIn: true })).toEqual({
        href: "/dashboard",
        label: "Homepage.nav.links.dashboard",
      });
    }
  });
});

describe("navGroups", () => {
  const hrefs = {
    docs: "https://docs.test/docs",
    llms: "https://docs.test/docs/ai/llms.txt",
    openApi: "https://api.test/openapi.json",
    github: "https://github.test/sdp",
  };
  const groups = navGroups(hrefs, { href: "/sign-up", label: "Homepage.nav.createAccount" });

  it("sends every way into the product through the primary action", () => {
    const waitlist = homepagePrimaryAction({ openSignup: false, signedIn: false });
    const links = navGroups(hrefs, waitlist).flatMap((group) => [
      ...group.features,
      ...group.columns.flat(),
    ]);

    expect(links.some((link) => link.href === "/dashboard")).toBe(false);
    const ways = links.filter((link) => link.href === waitlist.href);
    expect(ways.map((link) => link.label)).toEqual([
      "Homepage.nav.links.openSandbox",
      "Home.joinWaitlist",
    ]);
    for (const way of ways) expect(way.external).toBe(true);
  });

  it("points the docs group at the resolved destinations", () => {
    const docs = groups.find((group) => group.id === "docs");
    const hrefs = [...(docs?.features ?? []), ...(docs?.columns.flat() ?? [])].map(
      (link) => link.href
    );

    expect(hrefs).toEqual(
      expect.arrayContaining([
        "https://docs.test/docs",
        "https://docs.test/docs/ai/llms.txt",
        "https://api.test/openapi.json",
      ])
    );
  });

  it("marks every off-site link as opening a new tab", () => {
    const links = groups.flatMap((group) => [...group.features, ...group.columns.flat()]);

    for (const link of links) {
      const offSite = /^https?:\/\//.test(link.href) && !link.href.startsWith("https://docs.test");
      if (offSite) expect(link.external).toBe(true);
    }
  });
});
