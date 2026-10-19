import { PrivateChannelsListSkeleton } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";

export default function PrivateChannelsMembersLoading() {
  return <PrivateChannelsListSkeleton maxWidth="max-w-5xl" />;
}
