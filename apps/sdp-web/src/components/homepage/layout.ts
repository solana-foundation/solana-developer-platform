import type { CSSProperties } from "react";

/** The sticky bar's height in px; the page root hands it to CSS as `--nav-height`. */
export const NAV_HEIGHT = 56;

/** Room above an in-page anchor: the bar and 8px more. */
export const ANCHOR_OFFSET = NAV_HEIGHT + 8;

/**
 * The page's one layout breakpoint: at or under it the sections stack into one column. The CSS
 * modules write the same width as `@media (max-width: 1000px)`.
 */
export const NARROW_QUERY = "(max-width: 1000px)";

/** The page root's style: the bar's height as a CSS variable, so CSS and script share one value. */
export const homepageRootStyle = { "--nav-height": `${NAV_HEIGHT}px` } as CSSProperties;
