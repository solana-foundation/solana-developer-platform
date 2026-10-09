import { IntegrationsSkeleton } from "./integrations-skeleton";

export default function IntegrationsLoading() {
  return (
    <div className="contents" data-loading-layout="integrations">
      <IntegrationsSkeleton />
    </div>
  );
}
