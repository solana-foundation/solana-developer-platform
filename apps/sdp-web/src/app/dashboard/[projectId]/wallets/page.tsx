import CustodyPage from "../custody/page";

export default async function WalletsPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <CustodyPage params={params} />;
}
