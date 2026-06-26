"use client";

import type { PaymentRecurringPayment, PaymentRecurringPaymentStatus } from "@sdp/types";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { listRecurringPayments } from "./recurring-payments.data";

const STATUS_LABELS = {
  pending_activation: "Pending activation",
  activating: "Activating",
  active: "Active",
  canceling: "Canceling",
  resuming: "Resuming",
  paused: "Paused",
  canceled: "Canceled",
  expired: "Expired",
} as const satisfies Record<PaymentRecurringPaymentStatus, string>;

type LoadState =
  | { status: "loading"; recurringPayments: PaymentRecurringPayment[]; total: number }
  | { status: "ready"; recurringPayments: PaymentRecurringPayment[]; total: number }
  | { status: "error"; recurringPayments: PaymentRecurringPayment[]; total: number; error: string };

function RecurringPaymentStatusBadge({ status }: { status: PaymentRecurringPaymentStatus }) {
  return <Badge>{STATUS_LABELS[status]}</Badge>;
}

export function RecurringPaymentsWorkspace() {
  const [state, setState] = useState<LoadState>({
    status: "loading",
    recurringPayments: [],
    total: 0,
  });

  useEffect(() => {
    const controller = new AbortController();

    listRecurringPayments({ signal: controller.signal })
      .then((response) => {
        setState({
          status: "ready",
          recurringPayments: response.recurringPayments,
          total: response.total,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState({
          status: "error",
          recurringPayments: [],
          total: 0,
          error: error instanceof Error ? error.message : "Unable to load recurring payments",
        });
      });

    return () => controller.abort();
  }, []);

  const countLabel =
    state.total === 1 ? "1 recurring payment" : `${state.total} recurring payments`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col px-3 pb-5 md:px-6 md:pb-6">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-light py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-text-extra-high">Recurring payments</h2>
          <p className="mt-1 text-sm text-text-medium">{countLabel}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-4">
        {state.status === "loading" ? (
          <div className="border border-border-light bg-white p-4 text-sm text-text-medium">
            Loading recurring payments...
          </div>
        ) : null}

        {state.status === "error" ? (
          <div
            role="alert"
            className="border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text"
          >
            <p className="font-medium">Unable to load recurring payments</p>
            <p className="mt-1">{state.error}</p>
          </div>
        ) : null}

        {state.status === "ready" && state.recurringPayments.length === 0 ? (
          <div className="border border-border-light bg-white p-4 text-sm text-text-medium">
            No recurring payments yet.
          </div>
        ) : null}

        {state.status === "ready" && state.recurringPayments.length > 0 ? (
          <div className="overflow-hidden border border-border-light bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Amount</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.recurringPayments.map((recurringPayment) => (
                  <TableRow key={recurringPayment.id}>
                    <TableCell className="font-medium">
                      {formatDisplayAmount(recurringPayment.amount, recurringPayment.token)}
                    </TableCell>
                    <TableCell>{shortenAddress(recurringPayment.destinationAddress)}</TableCell>
                    <TableCell>{recurringPayment.periodHours}h</TableCell>
                    <TableCell>
                      {formatTimestamp(recurringPayment.nextCollectionDueAt ?? undefined)}
                    </TableCell>
                    <TableCell>
                      <RecurringPaymentStatusBadge status={recurringPayment.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
