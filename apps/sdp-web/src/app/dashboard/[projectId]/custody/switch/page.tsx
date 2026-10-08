import { redirect } from "next/navigation";
import { requestProjectHref } from "@/lib/sdp-api";

export default async function CustodySwitchPage() {
  redirect(await requestProjectHref("/dashboard/wallets/setup"));
}
