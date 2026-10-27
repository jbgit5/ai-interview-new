import OpenAI from "openai";
import { pool } from "@/lib/db";
import { insertTelemetryFireAndForget } from "@/lib/telemetry/server";

// POST /api/speak
// Body: { text: string; session_token?: string; trace_id?: string; format?: "mp3" | "pcm"; kind?: string }
//
// format "mp3" (default, standard engine): streams OpenAI TTS-1 "nova" mp3 for MediaSource playback.
//
// format "pcm" (pipeline engine): streams raw 24 kHz 16-bit mono PCM, which the browser schedules
// straight into WebAudio — no decoder warm-up, exact "audio started/ended" timing, and the same audio
// feeds the lip-sync avatar. Provider: Deepgram Aura (measured: OpenAI tts-1 took ~2.7 s to the first
// byte in real interviews) with OpenAI as an automatic fallback, so a provider problem never silences
// Maya. Requires a valid, unexpired, not-completed interview token: the endpoint spends company credits.

const PCM_SAMPLE_RATE = 24_000;
const MAX_CHARS = 1_200;

function pcmProviderOrder(): Array<"deepgram" | "openai"> {
  const preferred = (process.env.PIPELINE_TTS_PROVIDER ?? "deepgram").trim().toLowerCase();
  const order: Array<"deepgram" | "openai"> =
    preferred === "openai" ? ["openai", "deepgram"] : ["deepgram", "openai"];
  return order.filter((p) =>
    p === "deepgram" ? !!process.env.DEEPGRAM_API_KEY : !!process.env.OPENAI_API_KEY
  );
}

async function deepgramPcm(text: string, signal: AbortSignal): Promise<Response> {
  const voice = process.env.PIPELINE_TTS_VOICE?.trim() || "aura-2-thalia-en";
  const url =
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}` +
    `&encoding=linear16&sample_rate=${PCM_SAMPLE_RATE}&container=none`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`deepgram_http_${res.status} ${detail}`);
  }
  return res;
}

async function openaiPcm(text: string, signal: AbortSignal): Promise<Response> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.audio.speech.create(
    { model: "tts-1", voice: "nova", input: text, response_format: "pcm" },
    { signal }
  );
  return res as unknown as Response;
}

export async function POST(req: Request) {
  const body = await req.json();
  const text: string = body.text;
  const sessionToken: string | undefined = body.session_token;
  const traceId: string | undefined = body.trace_id;
  const format: "mp3" | "pcm" = body.format === "pcm" ? "pcm" : "mp3";
  const kind: string = typeof body.kind === "string" ? body.kind.slice(0, 20) : "line";

  if (!text?.trim()) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  if (format === "pcm") return speakPcm(text, sessionToken, traceId, kind);

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

async function speakPcm(
  text: string,
  sessionToken: string | undefined,
  traceId: string | undefined,
  kind: string
): Promise<Response> {
  if (text.length > MAX_CHARS) {
    return Response.json({ error: "text too long" }, { status: 400 });
  }
  if (!sessionToken) return Response.json({ error: "session_token required" }, { status: 401 });

  let sessionId: string | null = null;
  try {
    const found = await pool.query(
      `SELECT id, status, expires_at FROM interview_sessions WHERE token = $1::uuid`,
      [sessionToken]
    );
    const row = found.rows[0];
    if (!row) return Response.json({ error: "session_not_found" }, { status: 401 });
    if (new Date(row.expires_at) < new Date()) return Response.json({ error: "expired" }, { status: 410 });
    if (row.status === "completed") return Response.json({ error: "completed" }, { status: 409 });
    sessionId = row.id;
  } catch {
    return Response.json({ error: "session_lookup_failed" }, { status: 401 });
  }

  const providers = pcmProviderOrder();
  if (providers.length === 0) {
    return Response.json({ error: "No TTS service available" }, { status: 503 });
  }

  const t0 = Date.now();
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const upstream =
        provider === "deepgram"
          ? await deepgramPcm(text, AbortSignal.timeout(12_000))
          : await openaiPcm(text, AbortSignal.timeout(20_000));
      const ttfbMs = Date.now() - t0;
      if (sessionId) {
        insertTelemetryFireAndForget(pool, [
          {
            session_id: sessionId,
            event_name: "tts.pcm.completed",
            event_version: 1,
            source: "server",
            trace_id: traceId ?? null,
            turn_index: null,
            attrs: {
              provider,
              kind,
              tts_ttfb_ms: ttfbMs,
              chars: text.length,
              ...(failures.length ? { fallback_from: failures.join(" | ").slice(0, 200) } : {}),
            },
          },
        ]);
      }
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "audio/L16",
          "Cache-Control": "no-store",
          "X-TTS-Provider": provider,
          "X-TTS-Sample-Rate": String(PCM_SAMPLE_RATE),
          "X-TTS-TTFB-Ms": String(ttfbMs),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[speak] ${provider} pcm failed:`, msg);
      failures.push(`${provider}: ${msg.slice(0, 90)}`);
    }
  }

  if (sessionId) {
    insertTelemetryFireAndForget(pool, [
      {
        session_id: sessionId,
        event_name: "tts.error",
        event_version: 1,
        source: "server",
        trace_id: traceId ?? null,
        turn_index: null,
        attrs: { format: "pcm", kind, message: failures.join(" | ").slice(0, 300) },
      },
    ]);
  }
  return Response.json({ error: "tts_failed", detail: failures }, { status: 502 });
}
