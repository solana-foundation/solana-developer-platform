import type { TreasuryTableColumns } from "@/app/dashboard/[projectId]/markets/treasury-solutions/treasury-layout";
import type { EMBEDDED_YIELD_STRATEGY_COLUMNS } from "./embedded-yield-layout";

/**
 * What Earn's tables share on the refresh design, Treasury's and Embedded Yield's alike: the
 * frame each page and its route skeleton set them in. No "use client" directive: the
 * server-rendered loading boundaries read these as values, and a client module would hand them
 * reference proxies instead.
 *
 * Each table lays out by its own columns, by id, as fixed-layout widths that sum to 100% at each
 * width. Columns that do not fit a phone drop out below `@2xl` (a 672px work area), so a row's
 * action is always on screen without scrolling the table sideways.
 */

/** Any Earn table's columns: Treasury's tables and Embedded Yield's. */
export type EarnTableColumns = TreasuryTableColumns | typeof EMBEDDED_YIELD_STRATEGY_COLUMNS;

/** Hidden until the work area is 672px wide (`@2xl`). */
export const EARN_WIDE_ONLY_COLUMN = "hidden @2xl:table-cell";

/** A table set on the page: the design's 12px bleed, so cell text lines up with the title. */
export const EARN_TABLE_FRAME = "min-w-0 refresh:-mx-3";

/** The borderless design-system table, laid out by its columns' fixed widths. */
export const EARN_TABLE = "rounded-none border-0 [&_table]:table-fixed";
