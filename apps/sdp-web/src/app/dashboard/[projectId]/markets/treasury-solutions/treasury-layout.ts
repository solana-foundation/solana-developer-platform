import { EARN_WIDE_ONLY_COLUMN as WIDE_ONLY } from "@/app/dashboard/[projectId]/markets/earn/earn-table-layout";

/**
 * The Treasury page's table columns, shared by the page and its route skeleton so the two draw
 * the same widths by construction, in the frame every Earn table shares (`earn-table-layout.ts`,
 * which says how the widths work). No "use client" directive, for the same reason. A status
 * that drops out on a phone reads under the row's balance instead.
 */

export const TREASURY_POSITION_COLUMNS = {
  position: "w-[46%] @2xl:w-[34%]",
  wallet: `${WIDE_ONLY} @2xl:w-[20%]`,
  status: `${WIDE_ONLY} @2xl:w-[14%]`,
  balance: "w-[26%] text-right @2xl:w-[14%]",
  actions: "w-[28%] text-right @2xl:w-[18%]",
} as const;

export const TREASURY_STRATEGY_COLUMNS = {
  strategy: "w-[52%] @2xl:w-[40%]",
  apy: "w-[18%] text-right @2xl:w-[12%]",
  tvl: `${WIDE_ONLY} text-right @2xl:w-[16%]`,
  position: `${WIDE_ONLY} text-right @2xl:w-[16%]`,
  actions: "w-[30%] text-right @2xl:w-[16%]",
} as const;

export const TREASURY_PROGRAM_COLUMNS = {
  program: "w-[46%] @2xl:w-[40%]",
  status: `${WIDE_ONLY} @2xl:w-[18%]`,
  balance: "w-[26%] text-right @2xl:w-[20%]",
  actions: "w-[28%] text-right @2xl:w-[22%]",
} as const;

/**
 * The custody wallet tiles: one column on a phone, two once the column is 528px (`@xl`), the
 * Wallets page's gap.
 */
export const TREASURY_WALLET_GRID = "grid min-w-0 gap-5 @xl:grid-cols-2";

/** Any Treasury table's columns, as the route skeleton draws them. */
export type TreasuryTableColumns =
  | typeof TREASURY_POSITION_COLUMNS
  | typeof TREASURY_STRATEGY_COLUMNS
  | typeof TREASURY_PROGRAM_COLUMNS;

/**
 * The wallets body keeps one tile row's height in every state (a tile is 137px), so a load that
 * ends in an error moves nothing under it.
 */
export const TREASURY_WALLETS_BODY = "flex min-h-[8.5625rem] min-w-0 flex-col";

/**
 * The strategies body keeps the four-row table's height in every state (a 30px head over four
 * 65px rows), as the positions body keeps its two.
 */
export const TREASURY_STRATEGIES_BODY = "flex min-h-[18.125rem] min-w-0 flex-col gap-4";

/**
 * The positions body keeps the two-row table's height in every state (a 30px head over two
 * 65px rows), so the loading rows, an empty list and a short one share a footprint and the
 * sections under them never move.
 */
export const TREASURY_POSITIONS_BODY = "flex min-h-40 min-w-0 flex-col";
