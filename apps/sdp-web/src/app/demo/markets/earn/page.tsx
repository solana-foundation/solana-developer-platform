import { EarnProgramWorkspace } from "@/app/dashboard/markets/earn/earn-program-workspace";

export default async function EarnProgramDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ create?: string | string[] }>;
}) {
  const { create } = await searchParams;
  return (
    <EarnProgramWorkspace
      builderHref="/demo/markets/earn/button-builder"
      startInCreateMode={create === "1"}
    />
  );
}
