"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRiskScore, riskToneClassName, toProviderLabel } from "./payments-workspace.data";
import type { ComplianceSnapshot } from "./payments-workspace.types";

interface ProviderRiskTableProps {
  title: string;
  snapshot: ComplianceSnapshot | null;
  onClose?: () => void;
}

export function ProviderRiskTable({ title, snapshot, onClose }: ProviderRiskTableProps) {
  if (!snapshot || snapshot.providers.length === 0) {
    return null;
  }

  const providers = [...snapshot.providers].sort((left, right) =>
    toProviderLabel(left.provider).localeCompare(toProviderLabel(right.provider))
  );

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      ariaLabel={title}
      closeLabel={`Close ${title}`}
      contentClassName="rounded-[24px] border-[rgba(28,28,29,0.12)] p-6"
      size="xl"
    >
      <div className="mb-5 pr-14">
        <div className="space-y-1">
          <p className="text-[22px] font-medium text-[#1c1c1d]">{title}</p>
          <p className="text-sm text-[rgba(28,28,29,0.56)]">
            {new Date(snapshot.checkedAt).toLocaleString()}
          </p>
          <p className="text-sm text-[rgba(28,28,29,0.56)]">
            This screening checks major risk factors such as sanctions exposure and other compliance
            signals from the connected providers.
          </p>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Analysis</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((provider) => (
            <TableRow key={provider.provider}>
              <TableCell className="font-medium text-[#1c1c1d]">
                {toProviderLabel(provider.provider)}
              </TableCell>
              <TableCell className="text-[rgba(28,28,29,0.8)]">
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${riskToneClassName(provider)}`}
                >
                  {formatRiskScore(provider)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {onClose ? (
        <div className="mt-6 flex justify-end">
          <Button type="button" variant="secondary" onClick={() => onClose()}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
