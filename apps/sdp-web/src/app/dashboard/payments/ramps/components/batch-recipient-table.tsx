"use client";

import { CheckIcon, ChevronRight, CopyIcon, SearchIcon } from "lucide-react";
import { Fragment, useState } from "react";
import {
  formatTokenAmount,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import type { BatchEligibleRecipient, BatchRecipientEntry } from "../hooks/use-batch-send-wizard";

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "flex size-4 items-center justify-center rounded border transition-colors",
        checked ? "border-gray-1400 bg-gray-1400 text-white" : "border-border-medium"
      )}
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </button>
  );
}

interface CounterpartyGroup {
  counterpartyId: string;
  name: string;
  accounts: BatchEligibleRecipient[];
}

function groupByCounterparty(rows: BatchEligibleRecipient[]): CounterpartyGroup[] {
  const groups = new Map<string, CounterpartyGroup>();
  for (const account of rows) {
    const existing = groups.get(account.counterpartyId);
    if (existing) {
      existing.accounts.push(account);
    } else {
      groups.set(account.counterpartyId, {
        counterpartyId: account.counterpartyId,
        name: account.name,
        accounts: [account],
      });
    }
  }
  return [...groups.values()];
}

interface BatchRecipientTableProps {
  pageRecipients: BatchEligibleRecipient[];
  entries: Record<string, BatchRecipientEntry>;
  asset: string;
  displayAsset: string;
  isLoading?: boolean;
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onToggle: (recipient: BatchEligibleRecipient) => void;
  onToggleMany: (recipients: BatchEligibleRecipient[], value: boolean) => void;
  onAmountChange: (recipient: BatchEligibleRecipient, amount: string) => void;
}

export function BatchRecipientTable({
  pageRecipients,
  entries,
  asset,
  displayAsset,
  isLoading,
  page,
  pageCount,
  total,
  onPageChange,
  search,
  onSearchChange,
  onToggle,
  onToggleMany,
  onAmountChange,
}: BatchRecipientTableProps) {
  const { copy, copied } = useCopy(1200);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const trimmedAsset = asset.trim();
  const assetTitle = displayAsset === trimmedAsset ? undefined : asset;

  const toggleExpand = (counterpartyId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(counterpartyId)) {
        next.delete(counterpartyId);
      } else {
        next.add(counterpartyId);
      }
      return next;
    });

  const allRowsSelected =
    pageRecipients.length > 0 &&
    pageRecipients.every((recipient) => entries[recipient.counterpartyAccountId]);
  const groups = groupByCounterparty(pageRecipients);

  const handleCopy = (counterpartyAccountId: string, address: string) => {
    void copy(address);
    setCopiedId(counterpartyAccountId);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border-light">
      <div className="relative border-b border-border-light">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-low" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search counterparties"
          className="h-11 border-0 pl-9 shadow-none ring-0 [&>span:first-child]:border-0 [&>span:first-child]:bg-transparent"
        />
      </div>

      <Table className="rounded-none border-0">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 py-2 pl-3">
              <Check
                checked={allRowsSelected}
                onChange={() => onToggleMany(pageRecipients, !allRowsSelected)}
                label="Select all shown"
              />
            </TableHead>
            <TableHead className="py-2">Recipient</TableHead>
            <TableHead className="py-2 pr-3 text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={3} className="py-6 text-center text-sm text-text-low">
                Loading recipients…
              </TableCell>
            </TableRow>
          ) : groups.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="py-6 text-center text-sm text-text-low">
                {total === 0 ? "No counterparties with a Solana address." : "No matches."}
              </TableCell>
            </TableRow>
          ) : (
            groups.map((group) => {
              const isExpanded = expanded.has(group.counterpartyId);
              const selectedInGroup = group.accounts.filter(
                (account) => entries[account.counterpartyAccountId]
              ).length;
              const groupTotal = group.accounts.reduce((sum, account) => {
                const entry = entries[account.counterpartyAccountId];
                const value = entry ? Number(entry.amount) : 0;
                return sum + (Number.isFinite(value) ? value : 0);
              }, 0);
              return (
                <Fragment key={group.counterpartyId}>
                  <TableRow
                    className="cursor-pointer hover:bg-border-extra-light"
                    onClick={() => toggleExpand(group.counterpartyId)}
                  >
                    <TableCell className="py-2.5 pl-3">
                      <ChevronRight
                        className={cn(
                          "size-4 text-text-low transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-text-extra-high">
                          {group.name}
                        </span>
                        <span className="text-xs text-text-low">
                          {group.accounts.length} wallet{group.accounts.length === 1 ? "" : "s"}
                          {selectedInGroup > 0 ? ` · ${selectedInGroup} selected` : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 pr-3 text-right">
                      {groupTotal > 0 ? (
                        <span
                          className="text-sm font-medium text-text-extra-high"
                          title={assetTitle ? `${groupTotal} ${asset}` : undefined}
                        >
                          {formatTokenAmount(groupTotal)} {displayAsset}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  {isExpanded
                    ? group.accounts.map((account) => {
                        const isSelected = Boolean(entries[account.counterpartyAccountId]);
                        const entry = entries[account.counterpartyAccountId];
                        const isCopied = copied && copiedId === account.counterpartyAccountId;
                        const hasLabel = account.label !== null && account.label.trim().length > 0;
                        return (
                          <TableRow key={account.counterpartyAccountId}>
                            <TableCell className="py-2 pl-8">
                              <Check
                                checked={isSelected}
                                onChange={() => onToggle(account)}
                                label={`Select ${account.label ?? account.address}`}
                              />
                            </TableCell>
                            <TableCell className="py-2">
                              <div className="flex flex-col gap-0.5">
                                <span className="flex items-center gap-1.5 text-sm text-text-extra-high">
                                  {hasLabel ? (
                                    account.label
                                  ) : (
                                    <span className="font-mono">
                                      {shortenAddress(account.address)}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCopy(account.counterpartyAccountId, account.address)
                                    }
                                    aria-label={`Copy ${account.name} address`}
                                    className="transition-colors hover:text-text-extra-high"
                                  >
                                    {isCopied ? (
                                      <CheckIcon className="size-3" />
                                    ) : (
                                      <CopyIcon className="size-3" />
                                    )}
                                  </button>
                                </span>
                                {hasLabel ? (
                                  <span className="font-mono text-xs text-text-low">
                                    {shortenAddress(account.address)}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="py-2 pr-3 text-right">
                              <Input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={entry ? entry.amount : ""}
                                onChange={(event) =>
                                  onAmountChange(account, event.currentTarget.value)
                                }
                                placeholder="0.0"
                                className="ml-auto h-9 w-44 shadow-none ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
                                action={
                                  <span className="pr-1 text-sm text-text-low" title={assetTitle}>
                                    {displayAsset}
                                  </span>
                                }
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })
                    : null}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>

      {pageCount > 1 ? (
        <div className="border-t border-border-light p-2">
          <ArrowPagination
            page={page}
            pageCount={pageCount}
            onPageChange={onPageChange}
            summary={`${total} recipient${total === 1 ? "" : "s"}`}
          />
        </div>
      ) : null}
    </div>
  );
}
