"use client";

import { type ReactNode, useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";

type ActivityView = "transfers" | "batches";

/**
 * The Activity heading with its Transfers / Batches switch. Both lists are rendered on the
 * server and handed in; switching only swaps which one shows, so it costs no request.
 */
export function PaymentsActivityPanels({
  title,
  switchLabel,
  transfersLabel,
  batchesLabel,
  transfers,
  batches,
}: {
  title: string;
  switchLabel: string;
  transfersLabel: string;
  batchesLabel: string;
  transfers: ReactNode;
  batches: ReactNode;
}) {
  const [view, setView] = useState<ActivityView>("transfers");
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-subheading font-medium text-primary">{title}</h2>
        <SegmentedControl
          ariaLabel={switchLabel}
          value={view}
          onChange={(next) => setView(next === "batches" ? "batches" : "transfers")}
          options={[
            { value: "transfers", label: transfersLabel },
            { value: "batches", label: batchesLabel },
          ]}
        />
      </div>
      <div className="mt-4">{view === "transfers" ? transfers : batches}</div>
    </>
  );
}
