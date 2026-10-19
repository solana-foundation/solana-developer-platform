import { EarnIntegrationGuidePage } from "@/app/dashboard/[projectId]/markets/embedded-yield/integration-guide-page";

export const dynamic = "force-dynamic";

export default async function EmbeddedYieldConfigurePage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  return <EarnIntegrationGuidePage searchParams={searchParams} />;
}
