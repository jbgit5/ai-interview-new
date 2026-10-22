import { headers } from "next/headers";
import { auth } from "@/lib/auth";

// GET /api/deepgram/test-token
// Issues the Deepgram API key for the voice-test page.
// Protected by recruiter dashboard session (better-auth) — NEVER exposed in the browser bundle.
export async function GET() {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return Response.json({ error: "DEEPGRAM_API_KEY not configured" }, { status: 500 });
  }

  return Response.json({ key: process.env.DEEPGRAM_API_KEY });
}
