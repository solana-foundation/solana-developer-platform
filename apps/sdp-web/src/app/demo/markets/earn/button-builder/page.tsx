import { EarnButtonBuilder } from "@/app/dashboard/markets/earn/earn-button-builder";

export default async function EarnButtonBuilderDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const { strategy } = await searchParams;
  return (
    <EarnButtonBuilder
      earnHref="/demo/markets/earn"
      strategyId={typeof strategy === "string" ? strategy : undefined}
    />
  );
}
