/** Browsers only expose camera/mic on secure contexts (HTTPS or localhost). */
export function isMediaDevicesAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function getMediaDevicesBlockedMessage(): string {
  if (typeof window === "undefined") return "Camera/mic unavailable.";
  const { protocol, hostname } = window.location;
  if (protocol === "http:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
    return (
      "Camera and microphone require HTTPS on this server. " +
      "Local dev works on http://localhost, but production needs https://your-domain (or a Cloudflare Tunnel URL). " +
      "Plain http://IP-address is blocked by the browser."
    );
  }
  return "Camera/microphone API is not available in this browser.";
}

export async function requestUserMedia(
  constraints: MediaStreamConstraints
): Promise<MediaStream> {
  if (!isMediaDevicesAvailable()) {
    throw new Error(getMediaDevicesBlockedMessage());
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}
