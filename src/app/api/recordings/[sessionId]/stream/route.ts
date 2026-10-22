import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import path from "path";

// GET /api/recordings/[sessionId]/stream
// Concatenates all saved chunks and streams back a single webm blob.
export async function GET(
  _request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const { sessionId } = params;

    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), "recordings", sessionId);

    let files: string[];
    try {
      files = (await readdir(dir))
        .filter((f) => f.endsWith(".webm"))
        .sort(); // numeric sort by padded name (00000.webm, 00001.webm …)
    } catch {
      return NextResponse.json({ error: "No recording found" }, { status: 404 });
    }

    if (files.length === 0) {
      return NextResponse.json({ error: "No recording found" }, { status: 404 });
    }

    const chunks = await Promise.all(
      files.map((f) => readFile(path.join(dir, f)))
    );

    const combined = Buffer.concat(chunks);

    return new NextResponse(combined, {
      status: 200,
      headers: {
        "Content-Type": "video/webm",
        "Content-Length": String(combined.byteLength),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[recordings/stream]", err);
    return NextResponse.json({ error: "Failed to stream recording" }, { status: 500 });
  }
}
