import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const POSTMAN_COLLECTION_FILENAME = "solana-developer-platform-public.postman_collection.json";
const collectionPath = path.join(process.cwd(), "public", "postman", POSTMAN_COLLECTION_FILENAME);

export async function GET() {
  try {
    const body = await readFile(collectionPath, "utf8");

    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-disposition": `inline; filename="${POSTMAN_COLLECTION_FILENAME}"`,
      },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "POSTMAN_COLLECTION_UNAVAILABLE",
          message: "The generated Postman collection is not available.",
        },
      },
      { status: 503 }
    );
  }
}
