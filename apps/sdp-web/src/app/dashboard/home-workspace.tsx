import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Link from "next/link";
import type { HomeActivityRow } from "./home-page.data";
import { formatCurrencyAmount, formatDisplayAmount } from "./payments/payments-overview.utils";

interface HomeWorkspaceProps {
  totalBalance: number | null;
  totalBalanceError: string | null;
  todaysVolume: number | null;
  todaysVolumeError: string | null;
  activityRows: HomeActivityRow[];
  activityError: string | null;
  activityNotice: string | null;
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function truncateMiddle(value: string, start = 4, end = 4): string {
  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function MetricCard({
  label,
  value,
  error,
}: {
  label: string;
  value: number | null;
  error: string | null;
}) {
  return (
    <Card className="gap-0 rounded-[18px] border-[rgba(28,28,29,0.1)] py-0 shadow-none">
      <CardContent className="space-y-2 px-6 py-6">
        <p className="text-[15px] text-[rgba(28,28,29,0.56)]">{label}</p>
        <p className="text-[24px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d] sm:text-[30px]">
          {error ? "Unavailable" : formatCurrencyAmount(value)}
        </p>
        {error ? <p className="text-sm text-[#9e2b38]">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function HomeWorkspace({
  totalBalance,
  totalBalanceError,
  todaysVolume,
  todaysVolumeError,
  activityRows,
  activityError,
  activityNotice,
}: HomeWorkspaceProps) {
  return (
    <div className="w-full space-y-8 py-2">
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard label="Total Balance" value={totalBalance} error={totalBalanceError} />
        <MetricCard label="Today's Volume" value={todaysVolume} error={todaysVolumeError} />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-[30px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d]">
              Recent Transactions
            </h2>
            {activityNotice ? (
              <p className="text-sm text-[rgba(28,28,29,0.56)]">{activityNotice}</p>
            ) : null}
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link href="/dashboard/payments">See all payments</Link>
          </Button>
        </div>

        <Card className="gap-0 rounded-[20px] border-[rgba(28,28,29,0.1)] py-0 shadow-none">
          <CardContent className="px-0 py-0">
            {activityError ? (
              <div className="px-6 py-5 text-sm text-[#9e2b38]">{activityError}</div>
            ) : activityRows.length === 0 ? (
              <div className="px-6 py-5 text-sm text-[rgba(28,28,29,0.72)]">
                No recent activity found yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Time</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead className="pr-6">Address</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activityRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="pl-6 text-[rgba(28,28,29,0.72)]">
                          {formatRelativeTime(row.createdAt)}
                        </TableCell>
                        <TableCell className="font-medium">{row.type}</TableCell>
                        <TableCell className="text-[rgba(28,28,29,0.78)]">{row.token}</TableCell>
                        <TableCell className="text-[rgba(28,28,29,0.78)]">
                          {row.amount === "—" ? "—" : formatDisplayAmount(row.amount, row.token)}
                        </TableCell>
                        <TableCell
                          className="pr-6 font-mono text-xs text-[rgba(28,28,29,0.72)]"
                          title={row.address}
                        >
                          {truncateMiddle(row.address, 6, 4)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
