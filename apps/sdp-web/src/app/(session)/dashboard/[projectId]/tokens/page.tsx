import { auth } from "@clerk/nextjs/server";
import { HoldingsWorkspace } from "./holdings-workspace";

export default async function TokenHoldingsPage() {
  const { orgId } = await auth();
  if (!orgId) {
    return null;
  }
  return <HoldingsWorkspace />;
}
