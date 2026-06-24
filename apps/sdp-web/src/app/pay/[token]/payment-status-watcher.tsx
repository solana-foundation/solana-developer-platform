"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";

async function fetchStatus(url: string): Promise<{ status: string }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Status poll failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Polls the request status while it is awaiting payment and re-renders the
 * (server-rendered) page once it settles, so the payer sees "Payment received"
 * without a manual refresh. Renders nothing.
 */
export function PaymentStatusWatcher({ token }: { token: string }) {
  const router = useRouter();

  useSWR(`/api/pay/${encodeURIComponent(token)}/status`, fetchStatus, {
    refreshInterval: (data) => (data && data.status !== "awaiting_payment" ? 0 : 5000),
    revalidateOnFocus: false,
    onSuccess: (data) => {
      if (data.status !== "awaiting_payment") {
        router.refresh();
      }
    },
  });

  return null;
}
