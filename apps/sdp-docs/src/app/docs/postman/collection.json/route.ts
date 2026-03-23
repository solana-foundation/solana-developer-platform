import { readPostmanCollectionResponse } from "../../../../lib/postman-collection";

export const runtime = "nodejs";

export async function GET() {
  return readPostmanCollectionResponse();
}
