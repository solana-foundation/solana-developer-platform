import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CounterpartyWorkspace } from "./counterparty-workspace";

export default async function CounterpartyPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  return <CounterpartyWorkspace />;
}
