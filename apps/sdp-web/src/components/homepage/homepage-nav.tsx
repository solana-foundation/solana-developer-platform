import { getTranslations } from "@/i18n/server";
import { FILMS, filmUrl, SERIES_URL } from "./builders/films";
import type { HomepageLinks } from "./homepage-links";
import { NavShell } from "./nav/nav-shell";
import { NAV_GROUP_IDS, type NavGroup, type NavLink } from "./nav/nav-types";

/** The builders' films the Builders panel lists by name, by video id. */
const PANEL_FILM_IDS = ["ZfUtJgkE5dE", "QGRwG0XdTJs", "VdjsVXMcvrQ", "PN7ZoAEpcgo", "U9V2nmGMNUw"];
const PANEL_FILMS = FILMS.filter((film) => PANEL_FILM_IDS.includes(film.id));

/** The homepage's sticky bar: brand, the three groups with their panels, the account actions. */
export async function HomepageNav({ links }: { links: HomepageLinks }) {
  const t = await getTranslations();
  const sandbox: NavLink = {
    label: t("Homepage.nav.platform.sandbox"),
    href: links.signup.href,
    external: links.signup.external,
  };

  const groups: NavGroup[] = [
    {
      id: NAV_GROUP_IDS.platform,
      label: t("Homepage.nav.platform.label"),
      features: [
        {
          label: t("Homepage.nav.platform.issuance.title"),
          body: t("Homepage.nav.platform.issuance.body"),
          href: "#issuance",
        },
        {
          label: t("Homepage.nav.platform.payments.title"),
          body: t("Homepage.nav.platform.payments.body"),
          href: "#payments",
        },
        {
          label: t("Homepage.nav.platform.markets.title"),
          body: t("Homepage.nav.platform.markets.body"),
          href: "#markets",
        },
      ],
      links: [
        { label: t("Homepage.nav.platform.privacy"), href: "#privacy" },
        { label: t("Homepage.nav.platform.partners"), href: "#stack" },
        { label: t("Homepage.nav.platform.interfaces"), href: "#interfaces" },
        { label: t("Homepage.nav.platform.network"), href: "#network" },
        sandbox,
      ],
    },
    {
      id: NAV_GROUP_IDS.builders,
      label: t("Homepage.nav.builders.label"),
      features: [
        {
          label: t("Homepage.nav.builders.meet.title"),
          body: t("Homepage.nav.builders.meet.body"),
          href: "#builders",
        },
        {
          label: t("Homepage.nav.builders.walkthroughs.title"),
          body: t("Homepage.nav.builders.walkthroughs.body"),
          href: "#blog",
        },
        {
          label: t("Homepage.nav.builders.partners.title"),
          body: t("Homepage.nav.builders.partners.body"),
          href: "#stack",
        },
      ],
      links: [
        ...PANEL_FILMS.map((film) => ({
          label: film.name,
          href: filmUrl(film.id),
          external: true,
          ariaLabel: t("Homepage.builders.film", { name: film.name }),
        })),
        {
          label: t("Homepage.nav.builders.series"),
          href: SERIES_URL,
          external: true,
          ariaLabel: t("Homepage.nav.builders.seriesLabel"),
        },
      ],
    },
    {
      id: NAV_GROUP_IDS.docs,
      label: t("Homepage.nav.docs.label"),
      features: [
        {
          label: t("Homepage.nav.docs.docs.title"),
          body: t("Homepage.nav.docs.docs.body"),
          href: links.docs,
        },
        {
          label: t("Homepage.nav.docs.openapi.title"),
          body: t("Homepage.nav.docs.openapi.body"),
          href: links.openapi,
        },
        {
          label: t("Homepage.nav.docs.llms.title"),
          body: t("Homepage.nav.docs.llms.body"),
          href: links.llms,
        },
      ],
      links: [
        { label: t("Homepage.nav.docs.execute"), href: "#interfaces" },
        { label: t("Homepage.nav.docs.prepare"), href: "#interfaces" },
        { label: t("Homepage.nav.docs.dashboard"), href: links.signIn },
      ],
    },
  ];

  const mobileLinks: NavLink[] = [
    { label: t("Homepage.nav.platform.issuance.title"), href: "#issuance" },
    { label: t("Homepage.nav.platform.payments.title"), href: "#payments" },
    { label: t("Homepage.nav.platform.markets.title"), href: "#markets" },
    { label: t("Homepage.nav.platform.privacy"), href: "#privacy" },
    { label: t("Homepage.nav.platform.partners"), href: "#stack" },
    { label: t("Homepage.nav.mobile.builders"), href: "#builders" },
    { label: t("Homepage.nav.mobile.walkthroughs"), href: "#blog" },
    { label: t("Homepage.nav.platform.interfaces"), href: "#interfaces" },
    { label: t("Homepage.nav.docs.label"), href: links.docs },
  ];

  return (
    <NavShell
      copy={{
        skip: t("Homepage.nav.skip"),
        home: t("Homepage.nav.home"),
        primary: t("Homepage.nav.primary"),
        menu: t("Homepage.nav.menu"),
        openMenu: t("Homepage.nav.openMenu"),
        closeMenu: t("Homepage.nav.closeMenu"),
        signIn: t("Homepage.cta.signIn"),
      }}
      groups={groups}
      mobileLinks={mobileLinks}
      signInHref={links.signIn}
      signup={links.signup}
      signedIn={links.signedIn}
    />
  );
}
