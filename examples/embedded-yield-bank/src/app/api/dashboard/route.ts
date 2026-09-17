import { loadDashboard } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return apiSuccessResponse(await loadDashboard());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
