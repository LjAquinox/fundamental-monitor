import { z } from "zod/v4";
import { runtime, json, errorResponse, writeGuard } from "../../../lib/server";
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const { url } = z
      .object({ url: z.string().url().max(2000) })
      .strict()
      .parse(await request.json());
    if (!runtime().REPORT_DOWNLOAD)
      return json(
        {
          error:
            "Automatic download is available in the local app. Download the PDF and use Import PDF.",
        },
        400,
      );
    const bytes = await runtime().REPORT_DOWNLOAD(url);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
