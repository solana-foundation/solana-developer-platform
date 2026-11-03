"use client";

import { PAYMENT_REQUEST_STATUSES } from "@sdp/types/payments";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { z } from "zod";
import { payQueryKeys } from "@/app/pay/pay-query-key";

/**
 * How often an open link is read again. The API marks a request paid within 30s of its payment
 * landing, and every read here counts against the payer's own address's limit (20 a minute).
 */
const PAY_WATCH_INTERVAL_MS = 10_000;

type PayStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

const payStatusSchema = z.object({ status: z.enum(PAYMENT_REQUEST_STATUSES) });

async function fetchPayStatus(statusUrl: string): Promise<PayStatus> {
  const response = await fetch(statusUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Payment link read failed: ${response.status}`);
  }
  return payStatusSchema.parse(await response.json()).status;
}

/**
 * Watches an open payment link and redraws the page once it is paid, canceled or expired, so
 * the payer sees their payment land without a reload. The browser reads the API itself: the
 * page's own read runs on the web server, whose one address every payer would share.
 *
 * @param props.statusUrl - The API's read of this link, at an address the browser can reach.
 * @param props.status - The status the page was drawn with.
 * @returns Nothing visible.
 */
export function PayStatusWatch({ statusUrl, status }: { statusUrl: string; status: PayStatus }) {
  const router = useRouter();
  useSWR(
    status === "awaiting_payment" ? payQueryKeys.linkStatus(statusUrl) : null,
    ([, url]: readonly [string, string]) => fetchPayStatus(url),
    {
      // A fresh function each render re-arms SWR's timer with the latest read; before the first
      // one it sees nothing, and the open status the page was drawn with stands in.
      refreshInterval: (latest) =>
        latest === undefined || latest === "awaiting_payment" ? PAY_WATCH_INTERVAL_MS : 0,
      revalidateOnMount: false,
      revalidateOnFocus: true,
      dedupingInterval: 2_000,
      onSuccess: (latest) => {
        if (latest !== status) {
          router.refresh();
        }
      },
    }
  );
  return null;
}
