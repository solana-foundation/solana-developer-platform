/**
 * Typed catalog of every custom property tokens.css declares. The CSS is the source of the
 * values; this file names, groups and describes them so a Storybook (or any docs page) can
 * render swatches and scales by reading `getComputedStyle(element).getPropertyValue(name)`.
 * catalog.test.ts keeps the two in lockstep: a token missing from either side fails it.
 */

export const REFRESH_THEME_ATTRIBUTE = "data-sdp-theme";
export const REFRESH_THEME_VALUE = "refresh";

/** Spread onto the root element of a surface that renders in the 2026 refresh design. */
export const refreshThemeProps = { [REFRESH_THEME_ATTRIBUTE]: REFRESH_THEME_VALUE } as const;

/**
 * The scale names theme.css adds to Tailwind's `text`, `radius`, `spacing` and `container`
 * namespaces. Class mergers such as tailwind-merge need them to tell `text-body` (a size) from
 * `text-secondary` (a colour); without them `cn("text-success", "text-body")` drops the colour.
 */
export const tailwindThemeScales = {
  text: ["amount", "quote", "heading", "subheading", "field", "nav", "body", "meta", "page-title"],
  radius: ["control", "control-inner", "card"],
  spacing: ["control-sm", "control-md", "control-lg"],
  container: ["page", "flow"],
} as const;

export type DesignTokenGroup =
  | "surface"
  | "text"
  | "fill"
  | "border"
  | "status"
  | "destructive"
  | "font"
  | "paper"
  | "ink"
  | "wash"
  | "rule"
  | "hue"
  | "type"
  | "page-title"
  | "radius"
  | "control"
  | "layout"
  | "elevation"
  | "motion";

export interface DesignToken {
  readonly name: `--${string}`;
  readonly group: DesignTokenGroup;
  readonly description: string;
  /** Tailwind utility (from theme.css) that paints with this token, when there is one. */
  readonly utility?: string;
}

/**
 * Groups whose tokens have a separate dark-mode value under `:root.dark`: the palette and the
 * destructive hue. The product names (surface, text, fill, border, status, and the two base
 * faces) point at the palette, so they follow it into dark mode without a value of their own.
 */
export const THEMED_GROUPS: readonly DesignTokenGroup[] = [
  "destructive",
  "paper",
  "ink",
  "wash",
  "rule",
  "hue",
];

const token = (
  name: `--${string}`,
  group: DesignTokenGroup,
  description: string,
  utility?: string
): DesignToken => (utility ? { name, group, description, utility } : { name, group, description });

export const designTokens: readonly DesignToken[] = [
  token("--surface", "surface", "Shell and sidebar ground.", "bg-surface"),
  token("--surface-sunken", "surface", "Cards and wells on the page.", "bg-surface-sunken"),
  token("--surface-raised", "surface", "The page ground.", "bg-surface-raised"),
  token("--surface-tile", "surface", "Tiles and grouped lists on the page.", "bg-surface-tile"),

  token("--emph-xh", "text", "Headings, values, primary text.", "text-primary"),
  token("--emph-m", "text", "Secondary text and icons.", "text-secondary"),
  token("--emph-l", "text", "Labels, hints, placeholders.", "text-tertiary"),
  token("--emph-xl", "text", "Disabled text.", "text-muted"),
  token("--on-primary", "text", "Text on a primary (ink) fill.", "text-on-primary"),

  token("--t4", "fill", "Subtle tint: tiles, hover rows, footer bands.", "bg-fill-subtle"),
  token("--t8", "fill", "Tint: secondary buttons, segmented tracks.", "bg-fill"),
  token("--t12", "fill", "Strong tint: pressed states.", "bg-fill-strong"),

  token("--border-xl", "border", "Faint dividers between rows.", "border-border-subtle"),
  token("--border-l", "border", "Default rule: fields, sections, cards.", "border-border-default"),
  token("--border-m", "border", "Strong rule: outlined buttons, radios.", "border-border-strong"),

  token("--green-tx", "status", "Positive status text.", "text-success"),
  token("--green-bg", "status", "Positive status fill.", "bg-success-bg"),
  token("--green-brd", "status", "Positive callout border.", "border-success-border"),
  token("--amber-tx", "status", "Attention status text.", "text-warning"),
  token("--amber-bg", "status", "Attention status fill.", "bg-warning-bg"),
  token("--amber-brd", "status", "Attention callout border.", "border-warning-border"),
  token("--red-tx", "status", "Critical status text.", "text-error"),
  token("--red-bg", "status", "Critical status fill.", "bg-error-bg"),
  token("--red-brd", "status", "Critical callout border.", "border-error-border"),
  token("--blue-tx", "status", "In-progress status text.", "text-info"),
  token("--blue-bg", "status", "In-progress status fill.", "bg-info-bg"),
  token("--blue-brd", "status", "In-progress callout border.", "border-info-border"),

  token("--crimson", "destructive", "Destructive action.", "bg-destructive"),
  token("--crimson-strong", "destructive", "Destructive hover.", "bg-destructive-strong"),
  token("--crimson-strongest", "destructive", "Destructive pressed.", "bg-destructive-strongest"),
  token("--crimson-bg", "destructive", "Destructive tint.", "bg-destructive-bg"),
  token("--crimson-brd", "destructive", "Destructive border.", "border-destructive-border"),

  token("--font-sans", "font", "Body face; the font-sans utility and the design system read it."),
  token("--font-mono", "font", "Code and address face; the font-mono utility reads it."),
  token("--font-brand-sans", "font", "Season Sans, loaded from src/assets/fonts."),
  token("--font-brand-mono", "font", "Geist Mono, loaded from src/assets/fonts."),

  token("--paper", "paper", "The page ground."),
  token("--paper-side", "paper", "The sidebar ground, a step off the page."),
  token("--paper-card", "paper", "Cards, popovers and wells on the page."),
  token(
    "--paper-tile",
    "paper",
    "Tiles and grouped lists: the sidebar paper in light, a step above the card in dark."
  ),
  token("--chip", "paper", "The raised segment of a segmented control.", "bg-chip"),
  token("--chip-ring", "paper", "The hairline ring around a chip.", "shadow-chip"),

  token("--ink", "ink", "Headings and values."),
  token("--ink-secondary", "ink", "Labels and secondary lines."),
  token("--ink-tertiary", "ink", "Hints, placeholders, timestamps, table heads."),
  token("--ink-disabled", "ink", "Disabled text."),

  token("--wash", "wash", "Action tiles, footer band, tinted cards."),
  token("--wash-strong", "wash", "Hover on a wash."),
  token("--wash-strongest", "wash", "Pressed on a wash."),

  token("--rule-faint", "rule", "Dividers between list rows."),
  token("--rule", "rule", "Field underline, section and table-head rule."),
  token("--rule-strong", "rule", "Outlined buttons, provider cards, radios."),

  token("--positive", "hue", "Finalized, paid, completed."),
  token("--positive-wash", "hue", "Positive callout fill."),
  token("--positive-rule", "hue", "Positive callout border."),
  token("--progress", "hue", "Processing, settling, sent."),
  token("--progress-wash", "hue", "In-progress callout fill."),
  token("--progress-rule", "hue", "In-progress callout border."),
  token("--attention", "hue", "Pending, awaiting, needs approval."),
  token("--attention-wash", "hue", "Attention callout fill."),
  token("--attention-rule", "hue", "Attention callout border."),
  token("--critical", "hue", "Failed, cannot be undone."),
  token("--critical-wash", "hue", "Critical callout fill."),
  token("--critical-rule", "hue", "Critical callout border."),

  token("--font-size-amount", "type", "Hero figure: balances, amount to send.", "text-amount"),
  token("--line-height-amount", "type", "Line height for text-amount."),
  token("--letter-spacing-amount", "type", "Tracking for text-amount."),
  token("--font-size-quote", "type", "Quote figure on a provider card.", "text-quote"),
  token("--line-height-quote", "type", "Line height for text-quote."),
  token("--letter-spacing-quote", "type", "Tracking for text-quote."),
  token("--font-size-heading", "type", "Page and review headings.", "text-heading"),
  token("--line-height-heading", "type", "Line height for text-heading."),
  token("--letter-spacing-heading", "type", "Tracking for text-heading."),
  token("--font-size-subheading", "type", "Section titles and form questions.", "text-subheading"),
  token("--line-height-subheading", "type", "Line height for text-subheading."),
  token("--letter-spacing-subheading", "type", "Tracking for text-subheading."),
  token("--font-size-field", "type", "Form field values.", "text-field"),
  token("--line-height-field", "type", "Line height for text-field."),
  token("--font-size-nav", "type", "Sidebar items and tabs.", "text-nav"),
  token("--line-height-nav", "type", "Line height for text-nav."),
  token("--font-size-body", "type", "List and table text.", "text-body"),
  token("--line-height-body", "type", "Line height for text-body."),
  token("--font-size-meta", "type", "Labels, hints, secondary lines.", "text-meta"),
  token("--line-height-meta", "type", "Line height for text-meta."),

  token("--page-title-size", "page-title", "Shell page title size.", "text-page-title"),
  token("--page-title-line-height", "page-title", "Shell page title line height."),
  token("--page-title-letter-spacing", "page-title", "Shell page title tracking."),

  token("--corner-control", "radius", "Buttons, tiles, segmented tracks.", "rounded-control"),
  token("--corner-control-inner", "radius", "A control inside a control.", "rounded-control-inner"),
  token("--corner-card", "radius", "Framed content and callouts.", "rounded-card"),

  token("--control-height-sm", "control", "Filter buttons, segmented controls.", "h-control-sm"),
  token("--control-height-md", "control", "Outlined page actions.", "h-control-md"),
  token("--control-height-lg", "control", "Wizard footer actions.", "h-control-lg"),

  token("--page-max-width", "layout", "A page's content column, inside its gutters.", "max-w-page"),
  token("--flow-max-width", "layout", "Wizard and settings form column.", "max-w-flow"),

  token("--elevation-popover", "elevation", "Floating popovers and menus.", "shadow-ring"),

  token("--motion-duration-default", "motion", "Default transition duration."),
];
