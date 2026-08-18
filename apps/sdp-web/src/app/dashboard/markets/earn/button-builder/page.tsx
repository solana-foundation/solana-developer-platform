import { EarnButtonBuilder } from "../earn-button-builder";

export default async function EarnButtonBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string | string[] }>;
}) {
  const { strategy } = await searchParams;
  return (
    <EarnButtonBuilder
      earnHref="/dashboard/markets/earn"
      strategyId={typeof strategy === "string" ? strategy : undefined}
    />
  );
}
