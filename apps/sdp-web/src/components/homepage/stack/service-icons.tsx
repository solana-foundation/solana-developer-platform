import type { ReactNode } from "react";

/** The partner services the drawing cycles through, in order. */
export const STACK_SERVICES = ["custody", "compliance", "ramps", "nodes", "wallets"] as const;
export type StackService = (typeof STACK_SERVICES)[number];

/** What a product built on SDP can be; the product bubble cycles through them. */
export const STACK_PRODUCTS = ["wallet", "checkout", "payroll", "treasury"] as const;
export type StackProduct = (typeof STACK_PRODUCTS)[number];

const paths: Record<StackService, ReactNode> = {
  custody: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
      <path d="M12 14.2v2.2" />
    </>
  ),
  compliance: (
    <>
      <path d="M12 3.2 19 6v5.1c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6z" />
      <path d="m9 11.8 2.1 2.1L15.2 9.8" />
    </>
  ),
  ramps: (
    <>
      <path d="M5 8.5h13.5" />
      <path d="m15.5 5.5 3 3-3 3" />
      <path d="M19 15.5H5.5" />
      <path d="m8.5 12.5-3 3 3 3" />
    </>
  ),
  nodes: (
    <>
      <rect x="4" y="4.5" width="16" height="6.5" rx="2" />
      <rect x="4" y="13" width="16" height="6.5" rx="2" />
      <path d="M7.8 7.75h.01M7.8 16.25h.01" />
    </>
  ),
  wallets: (
    <>
      <path d="M5 7.5V7a2.5 2.5 0 0 1 2.5-2.5H17v3" />
      <rect x="4" y="7.5" width="16" height="12" rx="2.4" />
      <path d="M15.5 13.5h.01" />
    </>
  ),
};

/** The page's icon language: a 24 grid, round ends, drawn in the current colour. */
export function ServiceIcon({ service }: { service: StackService }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      {paths[service]}
    </svg>
  );
}
