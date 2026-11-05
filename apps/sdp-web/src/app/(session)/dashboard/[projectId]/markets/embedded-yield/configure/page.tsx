import { EarnIntegrationGuidePage } from "@/app/(session)/dashboard/[projectId]/markets/embedded-yield/integration-guide-page";

export default async function EmbeddedYieldConfigurePage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  return <EarnIntegrationGuidePage searchParams={searchParams} />;
}
