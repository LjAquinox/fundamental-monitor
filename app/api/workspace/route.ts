import { readWorkspace, json, errorResponse } from "../../../lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return json(await readWorkspace());
  } catch (e) {
    return errorResponse(e);
  }
}
