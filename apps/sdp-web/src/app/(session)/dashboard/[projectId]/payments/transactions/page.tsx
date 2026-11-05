import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { parseTransactionFilters } from "@/app/(session)/dashboard/[projectId]/payments/transactions/transactions-query";
import { getDashboardFlags } from "@/flags/dashboard";
import { enabledPaymentTransactionKinds, enabledTransactionModules } from "./transaction-modules";
import { TransactionsWorkspace } from "./transactions-workspace";

interface TransactionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const { orgId } = await auth();
  if (!orgId) redirect("/dashboard");

  const [params, flags] = await Promise.all([searchParams, getDashboardFlags()]);
  const modules = enabledTransactionModules(flags);

  return (
    <TransactionsWorkspace
      initialFilters={parseTransactionFilters(params, modules)}
      issuanceEnabled={flags.issuance}
      modules={modules}
      paymentKinds={enabledPaymentTransactionKinds(flags)}
    />
  );
}
