import type { SignupLink } from "../homepage-links";

export type NavGround = "paper" | "night";

export type NavLink = {
  label: string;
  href: string;
  /** Opens in a new tab (off-site forms, the films). */
  external?: boolean;
  /** The accessible name, when the label alone does not say the link opens a new tab. */
  ariaLabel?: string;
};

type NavFeature = NavLink & { body: string };

/** The groups' panel ids (unique on the page), in the bar's order. */
export const NAV_GROUP_IDS = {
  platform: "homepage-nav-platform",
  builders: "homepage-nav-builders",
  docs: "homepage-nav-docs",
} as const;

export type NavGroupId = (typeof NAV_GROUP_IDS)[keyof typeof NAV_GROUP_IDS];

/** One group of the bar: its trigger label and the panel it opens. */
export type NavGroup = {
  id: NavGroupId;
  label: string;
  features: NavFeature[];
  /** The quiet list beside the features, in reading order. */
  links: NavLink[];
};

type NavCopy = {
  skip: string;
  home: string;
  primary: string;
  menu: string;
  openMenu: string;
  closeMenu: string;
  signIn: string;
};

export type NavShellProps = {
  copy: NavCopy;
  groups: NavGroup[];
  mobileLinks: NavLink[];
  signInHref: string;
  signup: SignupLink;
  /** Show only the dashboard link (`signup`), not sign in beside it. */
  signedIn?: boolean;
};
