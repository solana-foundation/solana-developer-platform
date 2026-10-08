import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";

export default async function CustodySwitchPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(projectHref(projectId, "/dashboard/wallets/setup"));
}
