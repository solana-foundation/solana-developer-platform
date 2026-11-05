/**
 * What code needs from the tokens: the scale names theme.css adds to Tailwind. The values
 * themselves live in tokens.css and theme.css.
 */

/**
 * The scale names theme.css adds to Tailwind's `text`, `radius`, `spacing`, `container` and
 * `shadow` namespaces. Class mergers such as tailwind-merge need them to tell `text-body` (a
 * size) from `text-secondary` (a colour); without them `cn("text-success", "text-body")` drops
 * the colour, and `cn("shadow-chip", "shadow-red-500")` reads the chip as a shadow colour.
 */
export const tailwindThemeScales = {
  text: ["amount", "quote", "heading", "subheading", "field", "nav", "body", "meta", "page-title"],
  radius: ["control", "control-inner", "card"],
  spacing: ["control-sm", "control-md", "control-lg"],
  container: ["page", "flow"],
  shadow: ["chip", "ring"],
} as const;
