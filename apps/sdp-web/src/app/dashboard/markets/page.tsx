import { redirect } from "next/navigation";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";

export default function MarketsPage() {
  redirect(DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions);
}
