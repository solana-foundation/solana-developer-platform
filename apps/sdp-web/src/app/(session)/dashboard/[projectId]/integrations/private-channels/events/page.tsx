import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { EventsSection } from "./events-section";

export default async function PrivateChannelsEventsPage() {
  await requirePrivateChannelsAccess();
  return <EventsSection />;
}
