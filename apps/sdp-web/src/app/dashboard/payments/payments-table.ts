/**
 * The design's list-table type, shared by the Payments lists (Transactions, Requests,
 * Schedules, Contacts): cells are 13px on a 20px line, so a row is the table's 44px, or 48px
 * where a 24px control sits. A row's subject (its amount, or its name) adds `font-medium`.
 */
export const PAYMENTS_TABLE_CELL = "text-meta leading-5";

/**
 * Headings are 13px and regular. The design-system head reads its weight from
 * `--font-weight-medium`, so the head re-points that variable rather than fight the class.
 */
export const PAYMENTS_TABLE_HEAD = "text-meta [--font-weight-medium:var(--font-weight-regular)]";
