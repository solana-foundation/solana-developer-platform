import { MarketsLanding } from "./markets-landing";

export default async function MarketsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <MarketsLanding projectId={projectId} />;
}
