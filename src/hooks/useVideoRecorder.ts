import { useEffect, useRef, useCallback, useState } from "react";
import type { LocalVideoTrack, LocalAudioTrack } from "livekit-client";

interface UseVideoRecorderOptions {
  sessionId: string | null;
  videoTrack: LocalVideoTrack | null;
  audioTrack: LocalAudioTrack | null;
  enabled: boolean;
}

interface UseVideoRecorderReturn {
  isRecording: boolean;
  chunksUploaded: number;
  stop: () => void;
}

const CHUNK_INTERVAL_MS = 5000;

export function useVideoRecorder({
  sessionId,
  videoTrack,
  audioTrack,
  enabled,
}: UseVideoRecorderOptions): UseVideoRecorderReturn {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  const [isRecording, setIsRecording] = useState(false);
  const [chunksUploaded, setChunksUploaded] = useState(0);

  const uploadChunk = useCallback(
    async (blob: Blob, index: number) => {
      if (!sessionId) return;
      try {
        await fetch(`/api/recordings/${sessionId}/chunk?index=${index}`, {
          method: "POST",
          headers: { "Content-Type": "video/webm" },
          body: blob,
        });
        setChunksUploaded((n) => n + 1);
      } catch (err) {
        console.error("Failed to upload recording chunk:", err);
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
    if (!enabled || !sessionId || !videoTrack || !audioTrack) return;

    const videoMediaTrack = videoTrack.mediaStreamTrack;
    const audioMediaTrack = audioTrack.mediaStreamTrack;

    if (!videoMediaTrack || !audioMediaTrack) return;

    const stream = new MediaStream([videoMediaTrack, audioMediaTrack]);

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      recorder = new MediaRecorder(stream);
    }

    mediaRecorderRef.current = recorder;
    chunkIndexRef.current = 0;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        uploadChunk(e.data, chunkIndexRef.current++);
      }
    };

    recorder.onstart = () => setIsRecording(true);
    recorder.onstop = () => setIsRecording(false);

    recorder.start(CHUNK_INTERVAL_MS);

    return () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
  }, [enabled, sessionId, videoTrack, audioTrack, uploadChunk]);

  return { isRecording, chunksUploaded, stop };
}
