"use client";

import type { PAYMENT_REQUEST_STATUSES } from "@sdp/types/payments";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { payQueryKeys } from "@/app/pay/pay-query-key";
import { payLinkSchema } from "./pay-link";

/**
 * How often an open link is read again. The API marks a request paid within 30s of its payment
 * landing, and every read here counts against the payer's address's limit for link reads (20 a
 * minute), which the API keeps apart from the wallet's `/pay/:token/tx` requests.
 */
const PAY_WATCH_INTERVAL_MS = 10_000;

type PayStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

/** The watch needs only the status and whether the link can be paid. */
const payStatusSchema = payLinkSchema.pick({ status: true, solanaPayUrl: true });

/** What the page is drawn from: the status, and whether the API offers a way to pay. */
interface PayState {
  status: PayStatus;
  payable: boolean;
}

async function fetchPayState(statusUrl: string): Promise<PayState> {
  const response = await fetch(statusUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Payment link read failed: ${response.status}`);
  }
  const parsed = payStatusSchema.parse(await response.json());
  return { status: parsed.status, payable: parsed.solanaPayUrl !== null };
}

/**
 * Watches an open payment link and redraws the page once it is paid, canceled or expired, or
 * once the API starts or stops offering a way to pay it (its organization suspended or resumed,
 * HOO-2009), so the payer sees the change without a reload. The browser reads the API itself: the
 * page's own read runs on the web server, whose one address every payer would share.
 *
 * @param props.statusUrl - The API's read of this link, at an address the browser can reach.
 * @param props.status - The status the page was drawn with.
 * @param props.payable - Whether the page was drawn with a Solana Pay link.
 * @returns Nothing visible.
 */
export function PayStatusWatch({
  statusUrl,
  status,
  payable,
}: {
  statusUrl: string;
  status: PayStatus;
  payable: boolean;
}) {
  const router = useRouter();
  useSWR(
    status === "awaiting_payment" ? payQueryKeys.linkStatus(statusUrl) : null,
    ([, url]: readonly [string, string]) => fetchPayState(url),
    {
      // A fresh function each render re-arms SWR's timer with the latest read; before the first
      // one it sees nothing, and the open status the page was drawn with stands in.
      refreshInterval: (latest) =>
        latest === undefined || latest.status === "awaiting_payment" ? PAY_WATCH_INTERVAL_MS : 0,
      revalidateOnMount: false,
      revalidateOnFocus: true,
      dedupingInterval: 2_000,
      onSuccess: (latest) => {
        if (latest.status !== status || latest.payable !== payable) {
          router.refresh();
        }
      },
    }
  );
  return null;
}
