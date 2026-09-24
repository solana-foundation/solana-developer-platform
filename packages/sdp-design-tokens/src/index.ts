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
  text: ["amount", "quote", "heading", "subheading", "field", "body", "meta", "page-title"],
  radius: ["control", "control-inner", "card"],
  spacing: ["control-sm", "control-md", "control-lg"],
  container: ["flow"],
} as const;

export type DesignTokenGroup =
  | "surface"
  | "text"
  | "fill"
  | "border"
  | "status"
  | "destructive"
  | "refresh-ink"
  | "refresh-wash"
  | "refresh-rule"
  | "refresh-status"
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

/** Groups whose tokens have a separate dark-mode value under `:root.dark`. */
export const THEMED_GROUPS: readonly DesignTokenGroup[] = [
  "surface",
  "text",
  "fill",
  "border",
  "status",
  "destructive",
  "refresh-ink",
  "refresh-wash",
  "refresh-rule",
  "refresh-status",
];

const token = (
  name: `--${string}`,
  group: DesignTokenGroup,
  description: string,
  utility?: string
): DesignToken => (utility ? { name, group, description, utility } : { name, group, description });

export const designTokens: readonly DesignToken[] = [
  token("--surface", "surface", "App shell background.", "bg-surface"),
  token("--surface-sunken", "surface", "Inset wells and inputs on the shell.", "bg-surface-sunken"),
  token("--surface-raised", "surface", "Content card and popovers.", "bg-surface-raised"),

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

  token("--ink", "refresh-ink", "Refresh: headings and values."),
  token("--ink-secondary", "refresh-ink", "Refresh: labels and secondary lines."),
  token("--ink-tertiary", "refresh-ink", "Refresh: hints, placeholders, timestamps, table heads."),
  token("--ink-disabled", "refresh-ink", "Refresh: disabled text."),

  token("--wash", "refresh-wash", "Refresh: action tiles, footer band, tinted cards."),
  token("--wash-strong", "refresh-wash", "Refresh: hover on a wash."),
  token("--wash-strongest", "refresh-wash", "Refresh: pressed on a wash."),

  token("--rule-faint", "refresh-rule", "Refresh: dividers between list rows."),
  token("--rule", "refresh-rule", "Refresh: field underline, section and table-head rule."),
  token("--rule-strong", "refresh-rule", "Refresh: outlined buttons, provider cards, radios."),

  token("--positive", "refresh-status", "Refresh: finalized, paid, completed."),
  token("--positive-wash", "refresh-status", "Refresh: positive callout fill."),
  token("--positive-rule", "refresh-status", "Refresh: positive callout border."),
  token("--progress", "refresh-status", "Refresh: processing, settling, sent."),
  token("--progress-wash", "refresh-status", "Refresh: in-progress callout fill."),
  token("--progress-rule", "refresh-status", "Refresh: in-progress callout border."),
  token("--attention", "refresh-status", "Refresh: pending, awaiting, needs approval."),
  token("--attention-wash", "refresh-status", "Refresh: attention callout fill."),
  token("--attention-rule", "refresh-status", "Refresh: attention callout border."),
  token("--critical", "refresh-status", "Refresh: failed, cannot be undone."),
  token("--critical-wash", "refresh-status", "Refresh: critical callout fill."),
  token("--critical-rule", "refresh-status", "Refresh: critical callout border."),

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

  token("--flow-max-width", "layout", "Wizard and settings form column.", "max-w-flow"),

  token("--elevation-popover", "elevation", "Floating popovers and menus.", "shadow-ring"),

  token("--motion-duration-default", "motion", "Default transition duration."),
];
