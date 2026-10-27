import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  ConnectionState,
  LocalVideoTrack,
  LocalAudioTrack,
  Track,
} from "livekit-client";

/**
 * Camera/mic are opened by US and published as "user-provided" tracks.
 *
 * Why (reproduced in the e2e browser test, 2026-10-25): with LiveKit-created tracks, a browser
 * `devicechange` event (camera permission just granted, a webcam/headset plugged in, the OS default
 * changing) makes LiveKit "switch to the default device": it STOPS the working camera and re-opens it —
 * and the re-open failed (NotFoundError). The self-view went blank and nothing was recorded for the
 * whole interview. LiveKit never switches user-provided tracks. If the camera ends anyway (unplugged,
 * taken by another app) we re-open it ourselves and swap it into the same published track; `mediaVersion`
 * bumps so the self-view, recorder and camera watcher follow the new track.
 */
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24 },
  facingMode: "user",
};
const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };

interface UseLiveKitOptions {
  url: string;
  token: string;
  /** Observability — LiveKit disconnect / reconnect signals */
  onTelemetry?: (eventName: string, attrs: Record<string, unknown>) => void;
}

interface UseLiveKitReturn {
  room: Room | null;
  connectionState: ConnectionState;
  localVideoTrack: LocalVideoTrack | null;
  localAudioTrack: LocalAudioTrack | null;
  isConnected: boolean;
  isReconnecting: boolean;
  error: string | null;
  disconnect: () => void;
  /** Bumps whenever a local track's underlying camera/mic was replaced (re-attach / re-record). */
  mediaVersion: number;
}

export function useLiveKit({
  url,
  token,
  onTelemetry,
}: UseLiveKitOptions): UseLiveKitReturn {
  const onTelRef = useRef(onTelemetry);
  useEffect(() => {
    onTelRef.current = onTelemetry;
  }, [onTelemetry]);

  const roomRef = useRef<Room | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected
  );
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const localAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [localAudioTrack, setLocalAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaVersion, setMediaVersion] = useState(0);
  /** Set before we stop tracks on purpose, so the camera-recovery logic doesn't fight it. */
  const stoppingRef = useRef(false);

  const disconnect = useCallback(() => {
    // Stop local media tracks so browser releases the camera/mic indicator
    stoppingRef.current = true;
    localVideoTrack?.stop();
    localAudioTrack?.stop();
    roomRef.current?.disconnect();
  }, [localVideoTrack, localAudioTrack]);

  useEffect(() => {
    if (!url || !token) return;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;

    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      setConnectionState(state);
      if (state === ConnectionState.Reconnecting) {
        onTelRef.current?.("livekit.connection.reconnecting", {});
      }
      if (state === ConnectionState.Connected) {
        onTelRef.current?.("livekit.connection.connected", {});
      }
    });

    room.on(RoomEvent.Disconnected, (reason?: number) => {
      setConnectionState(ConnectionState.Disconnected);
      onTelRef.current?.("livekit.room.disconnected", {
        reason: reason != null ? String(reason) : undefined,
      });
    });

    let disposed = false;
    stoppingRef.current = false;

    /** Camera ended unexpectedly → open it again and swap it into the published track. */
    const watchCamera = (track: LocalVideoTrack) => {
      const mst = track.mediaStreamTrack;
      mst.addEventListener(
        "ended",
        async () => {
          if (disposed || stoppingRef.current) return;
          onTelRef.current?.("livekit.camera.lost", {});
          for (let attempt = 1; attempt <= 3 && !disposed && !stoppingRef.current; attempt++) {
            try {
              const s = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false });
              const fresh = s.getVideoTracks()[0];
              if (disposed || stoppingRef.current) {
                fresh.stop();
                return;
              }
              await track.replaceTrack(fresh, true);
              watchCamera(track);
              setMediaVersion((v) => v + 1);
              onTelRef.current?.("livekit.camera.reacquired", { attempt });
              return;
            } catch (err) {
              onTelRef.current?.("livekit.camera.reacquire_failed", {
                attempt,
                error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 120),
              });
              await new Promise((r) => setTimeout(r, 1_000 * attempt));
            }
          }
        },
        { once: true }
      );
    };

    async function connect() {
      try {
        await room.connect(url, token);

        // Camera: opened by us, published as user-provided (see CAMERA_CONSTRAINTS comment above).
        const cam = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false });
        if (disposed) {
          cam.getTracks().forEach((t) => t.stop());
          return;
        }
        const videoPub = await room.localParticipant.publishTrack(cam.getVideoTracks()[0], {
          source: Track.Source.Camera,
        });
        const videoTrack = videoPub.track as LocalVideoTrack;
        watchCamera(videoTrack);
        setLocalVideoTrack(videoTrack);
        localVideoTrackRef.current = videoTrack;

        // Microphone: same approach.
        const mic = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
        if (disposed) {
          mic.getTracks().forEach((t) => t.stop());
          return;
        }
        const audioPub = await room.localParticipant.publishTrack(mic.getAudioTracks()[0], {
          source: Track.Source.Microphone,
        });
        const audioTrack = audioPub.track as LocalAudioTrack;
        setLocalAudioTrack(audioTrack);
        localAudioTrackRef.current = audioTrack;
      } catch (err) {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : "Failed to connect";
        setError(msg);
        console.error("LiveKit connection error:", err);
      }
    }

    connect();

    return () => {
      disposed = true;
      stoppingRef.current = true;
      localVideoTrackRef.current?.stop();
      localAudioTrackRef.current?.stop();
      room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token]);

  return {
    room: roomRef.current,
    connectionState,
    localVideoTrack,
    localAudioTrack,
    isConnected: connectionState === ConnectionState.Connected,
    isReconnecting: connectionState === ConnectionState.Reconnecting,
    error,
    disconnect,
    mediaVersion,
  };
}
