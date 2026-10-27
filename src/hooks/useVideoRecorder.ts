import { useEffect, useRef, useCallback, useState } from "react";
import type { LocalVideoTrack, LocalAudioTrack } from "livekit-client";

interface UseVideoRecorderOptions {
  sessionId: string | null;
  videoTrack: LocalVideoTrack | null;
  audioTrack: LocalAudioTrack | null;
  enabled: boolean;
  /** Recorder lifecycle events — a failed recording used to be completely silent. */
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
  /** useLiveKit's mediaVersion: the camera/mic was replaced → record from the new tracks. */
  mediaVersion?: number;
}

interface UseVideoRecorderReturn {
  isRecording: boolean;
  chunksUploaded: number;
  stop: () => void;
}

const CHUNK_INTERVAL_MS = 5000;
/**
 * VP8 first: software VP9 encoding is several times more CPU-hungry, and with the voice engine,
 * avatar and proctoring all running, an interview lagged, the camera froze and NOTHING was recorded.
 * The bitrate cap keeps the encoder (and the 5 s uploads) light.
 */
const MIME_PREFERENCE = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
const VIDEO_BITS_PER_SECOND = 900_000;

export function useVideoRecorder({
  sessionId,
  videoTrack,
  audioTrack,
  enabled,
  onTelemetry,
  mediaVersion = 0,
}: UseVideoRecorderOptions): UseVideoRecorderReturn {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  /** Chunk numbering restarts only for a new session — never on a camera swap (would overwrite video). */
  const chunkSessionRef = useRef<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [chunksUploaded, setChunksUploaded] = useState(0);
  const telemetryRef = useRef(onTelemetry);
  telemetryRef.current = onTelemetry;
  const notStartedReportedRef = useRef(false);
  const uploadFailuresRef = useRef(0);

  const uploadChunk = useCallback(
    async (blob: Blob, index: number) => {
      if (!sessionId) return;
      try {
        const res = await fetch(`/api/recordings/${sessionId}/chunk?index=${index}`, {
          method: "POST",
          headers: { "Content-Type": "video/webm" },
          body: blob,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChunksUploaded((n) => n + 1);
        if (index === 0) telemetryRef.current?.("recorder.first_chunk", { bytes: blob.size });
      } catch (err) {
        console.error("Failed to upload recording chunk:", err);
        uploadFailuresRef.current++;
        // Report the first few failures, not every one.
        if (uploadFailuresRef.current <= 3) {
          telemetryRef.current?.("recorder.upload_failed", {
            index,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
          });
        }
      }
    },
    [sessionId]
  );

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Say WHY recording isn't starting (once), instead of silently never recording.
    const missing = !sessionId ? "session_id" : !videoTrack ? "video_track" : !audioTrack ? "audio_track" : null;
    if (missing) {
      if (!notStartedReportedRef.current) {
        notStartedReportedRef.current = true;
        telemetryRef.current?.("recorder.not_started", { missing });
      }
      return;
    }

    const videoMediaTrack = videoTrack!.mediaStreamTrack;
    const audioMediaTrack = audioTrack!.mediaStreamTrack;
    if (!videoMediaTrack || !audioMediaTrack) {
      telemetryRef.current?.("recorder.not_started", { missing: "media_stream_track" });
      return;
    }
    if (videoMediaTrack.readyState === "ended") {
      telemetryRef.current?.("recorder.not_started", { missing: "camera_track_ended" });
      return;
    }

    const stream = new MediaStream([videoMediaTrack, audioMediaTrack]);
    const mimeType = MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m));

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
    } catch (err) {
      try {
        recorder = new MediaRecorder(stream);
      } catch (err2) {
        telemetryRef.current?.("recorder.error", {
          stage: "create",
          error: (err2 instanceof Error ? err2.message : String(err2 ?? err)).slice(0, 120),
        });
        return;
      }
    }

    mediaRecorderRef.current = recorder;
    if (chunkSessionRef.current !== sessionId) {
      chunkSessionRef.current = sessionId;
      chunkIndexRef.current = 0;
    } else if (chunkIndexRef.current > 0) {
      telemetryRef.current?.("recorder.restarted", { continuing_at_chunk: chunkIndexRef.current, media_version: mediaVersion });
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        uploadChunk(e.data, chunkIndexRef.current++);
      }
    };
    recorder.onstart = () => {
      setIsRecording(true);
      telemetryRef.current?.("recorder.started", { mime: recorder.mimeType || mimeType || "default" });
    };
    recorder.onstop = () => {
      setIsRecording(false);
      telemetryRef.current?.("recorder.stopped", { chunks: chunkIndexRef.current });
    };
    recorder.onerror = (ev) => {
      const e = (ev as unknown as { error?: { name?: string; message?: string } }).error;
      telemetryRef.current?.("recorder.error", { stage: "record", error: `${e?.name ?? ""} ${e?.message ?? ""}`.trim().slice(0, 120) });
    };

    try {
      recorder.start(CHUNK_INTERVAL_MS);
    } catch (err) {
      telemetryRef.current?.("recorder.error", {
        stage: "start",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
      return;
    }

    return () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
  }, [enabled, sessionId, videoTrack, audioTrack, uploadChunk, mediaVersion]);

  return { isRecording, chunksUploaded, stop };
}
