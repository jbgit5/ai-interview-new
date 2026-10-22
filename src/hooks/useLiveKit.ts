import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  ConnectionState,
  LocalVideoTrack,
  LocalAudioTrack,
  createLocalVideoTrack,
  createLocalAudioTrack,
} from "livekit-client";

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

  const disconnect = useCallback(() => {
    // Stop local media tracks so browser releases the camera/mic indicator
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

    async function connect() {
      try {
        await room.connect(url, token);

        // Create and publish video track
        const videoTrack = await createLocalVideoTrack({
          resolution: { width: 1280, height: 720, frameRate: 24 },
          facingMode: "user",
        });
        await room.localParticipant.publishTrack(videoTrack);
        setLocalVideoTrack(videoTrack);
        localVideoTrackRef.current = videoTrack;

        // Create and publish audio track
        const audioTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
        });
        await room.localParticipant.publishTrack(audioTrack);
        setLocalAudioTrack(audioTrack);
        localAudioTrackRef.current = audioTrack;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to connect";
        setError(msg);
        console.error("LiveKit connection error:", err);
      }
    }

    connect();

    return () => {
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
  };
}
