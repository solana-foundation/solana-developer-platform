import { DEFAULT_SDP_API_URL, SDP_GITHUB_REPO_URL } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import { resolveDocsUrl } from "@/lib/docs-url";
import { filmUrl, SERIES_URL } from "./scenes/builders/films";

/** Off-site destinations the homepage links to, resolved once on the server. */
export type HomepageHrefs = {
  docs: string;
  llms: string;
  openApi: string;
  github: string;
};

export function resolveHomepageHrefs(): HomepageHrefs {
  return {
    docs: resolveDocsUrl(),
    llms: resolveDocsUrl("ai/llms.txt"),
    openApi: `${DEFAULT_SDP_API_URL}/openapi.json`,
    github: SDP_GITHUB_REPO_URL,
  };
}

export type NavLink = {
  href: string;
  label: MessageKey;
  /** Opens a new tab; the link says so to assistive technology. */
  external?: boolean;
  /** Left out of the mobile menu. */
  desktopOnly?: boolean;
};

export type NavFeature = NavLink & { description: MessageKey };

export type NavGroup = {
  id: "platform" | "builders" | "docs";
  label: MessageKey;
  features: NavFeature[];
  /** Up to two columns of plain links beside the features. */
  columns: NavLink[][];
};

/** The Solana Foundation contact form, which is also the waitlist while signup is closed. */
export const CONTACT_HREF = "https://solanafoundation.typeform.com/to/PLfMTDQs";

/**
 * Where the page's main action leads: the dashboard for a visitor who is
 * signed in; account creation while signup is open; the waitlist otherwise.
 */
export function homepagePrimaryAction({
  openSignup,
  signedIn,
}: {
  openSignup: boolean;
  signedIn: boolean;
}): NavLink {
  if (signedIn) return { href: "/dashboard", label: "Homepage.nav.links.dashboard" };
  return openSignup
    ? { href: "/sign-up", label: "Homepage.nav.createAccount" }
    : { href: CONTACT_HREF, label: "Home.joinWaitlist", external: true };
}

/**
 * The nav's groups. Every way into the product follows `primaryAction`, so a
 * signed-out visitor is never sent to /dashboard only to bounce off sign-in.
 */
export function navGroups(hrefs: HomepageHrefs, primaryAction: NavLink): NavGroup[] {
  return [
    {
      id: "platform",
      label: "Homepage.nav.groups.platform",
      features: [
        {
          href: "#issuance",
          label: "Homepage.nav.items.issuance.title",
          description: "Homepage.nav.items.issuance.description",
        },
        {
          href: "#payments",
          label: "Homepage.nav.items.payments.title",
          description: "Homepage.nav.items.payments.description",
        },
        {
          href: "#markets",
          label: "Homepage.nav.items.markets.title",
          description: "Homepage.nav.items.markets.description",
        },
      ],
      columns: [
        [
          { href: "#privacy", label: "Homepage.nav.links.privacy" },
          { href: "#stack", label: "Homepage.nav.links.partners" },
          { href: "#interfaces", label: "Homepage.nav.links.interfaces" },
        ],
        [
          { href: "#network", label: "Homepage.nav.links.network" },
          { ...primaryAction, label: "Homepage.nav.links.openSandbox" },
        ],
      ],
    },
    {
      id: "builders",
      label: "Homepage.nav.groups.builders",
      features: [
        {
          href: "#builders",
          label: "Homepage.nav.items.meetBuilders.title",
          description: "Homepage.nav.items.meetBuilders.description",
        },
        {
          href: "#walkthroughs",
          label: "Homepage.nav.items.walkthroughs.title",
          description: "Homepage.nav.items.walkthroughs.description",
        },
        {
          href: "#stack",
          label: "Homepage.nav.items.partners.title",
          description: "Homepage.nav.items.partners.description",
        },
      ],
      columns: [
        [
          {
            href: filmUrl("Fireblocks"),
            label: "Homepage.nav.links.fireblocks",
            external: true,
            desktopOnly: true,
          },
          {
            href: filmUrl("Helius"),
            label: "Homepage.nav.links.helius",
            external: true,
            desktopOnly: true,
          },
          {
            href: filmUrl("Alchemy"),
            label: "Homepage.nav.links.alchemy",
            external: true,
            desktopOnly: true,
          },
        ],
        [
          {
            href: filmUrl("Coinbase"),
            label: "Homepage.nav.links.coinbase",
            external: true,
            desktopOnly: true,
          },
          {
            href: filmUrl("BitGo"),
            label: "Homepage.nav.links.bitgo",
            external: true,
            desktopOnly: true,
          },
          {
            href: SERIES_URL,
            label: "Homepage.nav.links.wholeSeries",
            external: true,
            desktopOnly: true,
          },
        ],
      ],
    },
    {
      id: "docs",
      label: "Homepage.nav.groups.docs",
      features: [
        {
          href: hrefs.docs,
          label: "Homepage.nav.items.docs.title",
          description: "Homepage.nav.items.docs.description",
        },
        {
          href: hrefs.openApi,
          label: "Homepage.nav.items.openApi.title",
          description: "Homepage.nav.items.openApi.description",
          external: true,
        },
        {
          href: hrefs.llms,
          label: "Homepage.nav.items.llms.title",
          description: "Homepage.nav.items.llms.description",
          external: true,
        },
      ],
      columns: [
        [
          { href: "#interfaces", label: "Homepage.nav.links.executeMode" },
          { href: "#interfaces", label: "Homepage.nav.links.prepareMode" },
        ],
        [primaryAction],
      ],
    },
  ];
}
