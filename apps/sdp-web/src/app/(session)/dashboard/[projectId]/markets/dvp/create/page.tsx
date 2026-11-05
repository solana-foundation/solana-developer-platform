import { issuance } from "@/flags";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { DvpCreateClient } from "./dvp-create-client";

export default async function DvpCreatePage() {
  await redirectUnlessCanWrite("/dashboard/markets/dvp");
  return <DvpCreateClient issuanceEnabled={await issuance()} />;
}
