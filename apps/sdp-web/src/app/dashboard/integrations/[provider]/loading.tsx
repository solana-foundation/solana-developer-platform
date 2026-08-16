import { IntegrationDetailSkeleton } from "../integrations-skeleton";

/**
 * The server and client loading paths render one component on purpose: this
 * file used to hand-duplicate the skeleton, so a section added to the page only
 * ever reached whichever copy the author happened to open.
 */
export default function IntegrationDetailLoading() {
  return <IntegrationDetailSkeleton />;
}
