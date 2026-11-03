import { EARN_WIDE_ONLY_COLUMN } from "./earn-table-layout";

/**
 * Embedded Yield's portfolio table, shared by the page and its route skeleton so the two draw
 * the same widths by construction (see `earn-table-layout.ts`). On a phone the counts and the
 * last deposit drop, and the strategy, its live value and the row's toggle share the column.
 */
export const EMBEDDED_YIELD_STRATEGY_COLUMNS = {
  strategy: "w-[56%] @2xl:w-[34%]",
  wallets: `${EARN_WIDE_ONLY_COLUMN} text-right @2xl:w-[12%]`,
  positions: `${EARN_WIDE_ONLY_COLUMN} text-right @2xl:w-[12%]`,
  lastDeposit: `${EARN_WIDE_ONLY_COLUMN} @2xl:w-[18%]`,
  value: "w-[32%] text-right @2xl:w-[18%]",
  toggle: "w-[12%] text-right @2xl:w-[6%]",
} as const;

/**
 * A strategy's customer wallets, opened under its row on the table's own tracks so each figure
 * sits under its column: the address across the strategy and both counts, then the last
 * deposit's track, the live value, and the toggle's.
 */
export const EMBEDDED_YIELD_WALLET_GRID =
  "grid grid-cols-[56%_32%_12%] @2xl:grid-cols-[58%_18%_18%_6%]";
