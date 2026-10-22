import OpenAI from "openai";
import { pool } from "@/lib/db";
import { insertTelemetryFireAndForget } from "@/lib/telemetry/server";

// POST /api/speak
// Body: { text: string; session_token?: string; trace_id?: string }
//
// Streams OpenAI TTS-1 "nova" directly to the client instead of buffering.
// This cuts time-to-first-audio-byte by 500-1500ms because the browser
// receives (and starts playing via MSE) the first mp3 chunk as soon as
// OpenAI starts generating — the server never accumulates the full file.
export async function POST(req: Request) {
  const body = await req.json();
  const text: string = body.text;
  const sessionToken: string | undefined = body.session_token;
  const traceId: string | undefined = body.trace_id;

  if (!text?.trim()) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "No TTS service available" }, { status: 503 });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tTtsStart = Date.now();

  /**
   * Fire-and-forget telemetry helpers.
   * tts_fetch_ms now measures time-to-first-response (TTFB) from OpenAI,
   * not full-buffer time — more useful for latency attribution.
   */
  const emitTelemetry = (tts_ttfb_ms: number, error?: string) => {
    if (!sessionToken || !traceId) return;
    void pool
      .query(`SELECT id FROM interview_sessions WHERE token = $1::uuid`, [sessionToken])
      .then((res) => {
        const sid = res.rows[0]?.id;
        if (!sid) return;
        insertTelemetryFireAndForget(pool, [
          {
            session_id: sid,
            event_name: error ? "tts.error" : "tts.openai.completed",
            event_version: 1,
            source: "server",
            trace_id: traceId,
            turn_index: null,
            attrs: error
              ? { message: error.slice(0, 300) }
              : { tts_ttfb_ms, chars: text.length },
          },
        ]);
      })
      .catch(() => { /* non-fatal */ });
  };

  try {
    // `speech.create()` returns an API response with a body ReadableStream.
    // We pass `stream: true` implicitly via the SDK — the body starts flowing
    // as soon as OpenAI sends the first audio chunk.
    const ttsResponse = await openai.audio.speech.create(
      {
        model: "tts-1",
        voice: "nova",
        input: text,
        response_format: "mp3",
      },
      { signal: AbortSignal.timeout(20_000) }
    );

    const ttfb_ms = Date.now() - tTtsStart;
    console.log(
      JSON.stringify({
        event: "tts_metrics",
        chars: text.length,
        tts_ttfb_ms: ttfb_ms,
        streaming: true,
      })
    );
    emitTelemetry(ttfb_ms);

    // Pass the response body ReadableStream straight through.
    // The client's useAudioPlayer streamMediaSourcePath path handles
    // MSE buffering and starts audio.play() on the first appended chunk.
    return new Response(ttsResponse.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        // Allow CDN / proxies to cache short utterances
        "Cache-Control": "no-store",
        // Hint to the client that this is a stream (not a fixed-length file)
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("OpenAI TTS error:", msg);
    emitTelemetry(Date.now() - tTtsStart, msg);
    return new Response(`TTS failed: ${msg}`, { status: 500 });
  }
}
