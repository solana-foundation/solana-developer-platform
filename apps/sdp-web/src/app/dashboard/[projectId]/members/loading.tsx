import { SettingsPageSkeleton } from "../operations-card-page-skeletons";

// The route only redirects into Settings, so it loads as Settings instead of
// inheriting the Home skeleton from the dashboard segment.
export default function MembersLoading() {
  return <SettingsPageSkeleton />;
}
