import { readFile } from "node:fs/promises";
import path from "node:path";
import { POSTMAN_COLLECTION_FILENAME } from "../../scripts/lib/public-openapi.mjs";

const collectionPath = path.join(process.cwd(), "public", "postman", POSTMAN_COLLECTION_FILENAME);

export async function readPostmanCollectionResponse() {
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
