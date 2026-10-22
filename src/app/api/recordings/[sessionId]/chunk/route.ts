import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

// POST /api/recordings/[sessionId]/chunk?index=N
// Accepts a raw video/webm blob and saves it to recordings/{sessionId}/{index}.webm
export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const { sessionId } = params;
    const index = request.nextUrl.searchParams.get("index") ?? "0";

    // Sanitise inputs — sessionId should be a UUID
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), "recordings", sessionId);
    await mkdir(dir, { recursive: true });

    const buf = Buffer.from(await request.arrayBuffer());
    const filePath = path.join(dir, `${index.padStart(5, "0")}.webm`);
    await writeFile(filePath, buf);

    return NextResponse.json({ ok: true, index });
  } catch (err) {
    console.error("[recordings/chunk]", err);
    return NextResponse.json({ error: "Failed to save chunk" }, { status: 500 });
  }
}
