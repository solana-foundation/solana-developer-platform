"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[#1c1c1d]">{title}</p>
        <div className="flex items-center gap-2">
          <p className="text-xs text-[rgba(28,28,29,0.56)]">
            {new Date(snapshot.checkedAt).toLocaleString()}
          </p>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(28,28,29,0.12)] text-xs font-semibold text-[rgba(28,28,29,0.66)] transition-colors hover:bg-[rgba(28,28,29,0.06)]"
            >
              X
            </button>
          ) : null}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Risk score</TableHead>
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
    </div>
  );
}
