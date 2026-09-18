import { loadDashboard } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ACTIVE_MOVEMENTS = 10;

export async function GET(request: Request) {
  try {
    const activeMovementIds = [
      ...new Set(
        new URL(request.url).searchParams
          .getAll("movementId")
          .filter((movementId) => movementId.length > 0)
      ),
    ].slice(0, MAX_ACTIVE_MOVEMENTS);
    return apiSuccessResponse(await loadDashboard(activeMovementIds));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
