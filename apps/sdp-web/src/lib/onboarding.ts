import { sdpApiFetch } from "@/lib/sdp-api";

export async function linkOrganizationInApi() {
  await sdpApiFetch("/v1/onboarding/link-org", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
