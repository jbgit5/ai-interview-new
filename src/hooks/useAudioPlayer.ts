import {
  useRef,
  useCallback,
  useEffect,
  type MutableRefObject,
} from "react";

export type AddLog = (
  level: "info" | "success" | "error" | "warn",
  step: string,
  message: string
) => void;

export interface AudioPlayerTelemetryOptions {
  sessionToken?: string;
  /** Correlates TTS with the current interview turn (same as brain/STT trace). */
  getTraceId?: () => string | undefined;
}

export interface SpeakPlaybackResult {
  /** True when `abortPlayback()` fired or fetch/stream was aborted mid‑playback */
  aborted: boolean;
}

/** Optional hooks for TTS (e.g. align mic barge‑in grace with real audio output). */
export interface SpeakOptions {
  /** Fires once when playback actually starts (after fetch / buffer priming). */
  onPlaybackStarted?: () => void;
}

export function useAudioPlayer(
  addLog?: AddLog,
  telemetry?: AudioPlayerTelemetryOptions
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const telemetryRef = useRef(telemetry);
  const playbackAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  const unlockAudio = useCallback(() => {
    try {
      const silent = new Audio(
        "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU3LjcxLjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAABAAADQgD///////////////////////////////////////////8AAAA"
      );
      silent.volume = 0;
      silent.play().catch(() => {});
    } catch {
      // Non-fatal
    }
  }, []);

  const abortPlayback = useCallback(() => {
    playbackAbortRef.current?.abort();
    playbackAbortRef.current = null;
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
  }, []);

  const speak = useCallback(
    async (text: string, options?: SpeakOptions): Promise<SpeakPlaybackResult> => {
      abortPlayback();

      addLog?.(
        "info",
        "TTS",
        `Requesting speech: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`
      );

      let playbackHookFired = false;
      const firePlaybackStarted = () => {
        if (playbackHookFired) return;
        playbackHookFired = true;
        options?.onPlaybackStarted?.();
      };

      const ac = new AbortController();
      playbackAbortRef.current = ac;
      const signal = ac.signal;

      let mediaTeardown: (() => void) | null = null;
      signal.addEventListener(
        "abort",
        () => {
          mediaTeardown?.();
          mediaTeardown = null;
          if (audioRef.current) {
            try {
              audioRef.current.pause();
            } catch {
              /* ignore */
            }
            audioRef.current = null;
          }
          addLog?.("warn", "TTS", "Playback aborted — candidate may have resumed speaking");
        },
        { once: true }
      );

      const tel = telemetryRef.current;
      const traceId = tel?.getTraceId?.();
      try {
        const response = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            text,
            ...(tel?.sessionToken && traceId
              ? { session_token: tel.sessionToken, trace_id: traceId }
              : {}),
          }),
        });

        if (signal.aborted) return { aborted: true };

        if (!response.ok) {
          const errText = await response.text();
          addLog?.("error", "TTS", `TTS API failed — HTTP ${response.status}: ${errText}`);
          throw new Error("TTS request failed");
        }

        const contentType = response.headers.get("Content-Type") ?? "audio/mpeg";

        const canStream =
          typeof MediaSource !== "undefined" &&
          typeof MediaSource.isTypeSupported === "function" &&
          (MediaSource.isTypeSupported("audio/mpeg") ||
            MediaSource.isTypeSupported("audio/mp4"));

        if (canStream && response.body) {
          return await streamMediaSourcePath(
            response,
            contentType,
            signal,
            addLog,
            audioRef,
            (cb) => {
              mediaTeardown = cb;
            },
            firePlaybackStarted
          );
        }

        const audioBlob = await response.blob();
        if (signal.aborted) return { aborted: true };
        addLog?.(
          "success",
          "TTS",
          `Audio ready (${(audioBlob.size / 1024).toFixed(1)} KB) — playing`
        );
        const audioUrl = URL.createObjectURL(audioBlob);
        mediaTeardown = () => URL.revokeObjectURL(audioUrl);
        return blobPlayControlled(audioUrl, addLog, signal, audioRef, firePlaybackStarted);
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return { aborted: true };
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        if (playbackAbortRef.current === ac) playbackAbortRef.current = null;
      }
    },
    [abortPlayback, addLog]
  );

  const stop = useCallback(() => {
    abortPlayback();
  }, [abortPlayback]);

  return { speak, stop, unlockAudio, abortPlayback };
}

async function streamMediaSourcePath(
  response: Response,
  contentType: string,
  signal: AbortSignal,
  addLog: AddLog | undefined,
  audioRef: MutableRefObject<HTMLAudioElement | null>,
  assignTeardown: (fn: () => void) => void,
  onPlaybackStarted?: () => void
): Promise<SpeakPlaybackResult> {
  const mimeType = contentType.includes("ogg")
    ? "audio/ogg; codecs=opus"
    : contentType.includes("mp4")
      ? "audio/mp4"
      : "audio/mpeg";

  return new Promise<SpeakPlaybackResult>((resolve, reject) => {
    const ms = new MediaSource();
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(ms);
    audio.src = objectUrl;
    audioRef.current = audio;

    let settled = false;
    let readerCancelFn: null | (() => Promise<void>) = null;

    const safetyTimer = setTimeout(() => {
      addLog?.("warn", "TTS", "Safety timeout — continuing");
      safetyCleanup();
      if (!settled) {
        settled = true;
        resolve({ aborted: false });
      }
    }, 60000);

    function safetyCleanup() {
      clearTimeout(safetyTimer);
    }

    const hardTeardown = () => {
      safetyCleanup();
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {
        /* ignore */
      }
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      audio.removeAttribute("src");
      audioRef.current = null;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      void readerCancelFn?.();
    };

    assignTeardown(() => {
      hardTeardown();
    });

    ms.addEventListener(
      "sourceopen",
      () => {
        void (async () => {
          let sb: SourceBuffer;
          try {
            sb = ms.addSourceBuffer(mimeType);
          } catch {
            hardTeardown();
            if (!settled) {
              settled = true;
              reject(new Error("MediaSource unsupported"));
            }
            return;
          }

          const reader = response.body!.getReader();
          readerCancelFn = async () => {
            try {
              await reader.cancel();
            } catch {
              /* noop */
            }
          };

          let startedPlaying = false;

          const waitUpdateEnd = () =>
            new Promise<void>((r) =>
              sb.updating
                ? sb.addEventListener("updateend", () => r(), { once: true })
                : r()
            );

          if (signal.aborted) {
            hardTeardown();
            if (!settled) {
              settled = true;
              resolve({ aborted: true });
            }
            return;
          }

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (signal.aborted) {
                await reader.cancel().catch(() => {});
                hardTeardown();
                if (!settled) {
                  settled = true;
                  resolve({ aborted: true });
                }
                return;
              }

              await waitUpdateEnd();

              if (done) {
                try {
                  if (ms.readyState === "open") ms.endOfStream();
                } catch {
                  /* ignore */
                }
                break;
              }

              sb.appendBuffer(value);
              await waitUpdateEnd();

              if (!startedPlaying) {
                startedPlaying = true;
                onPlaybackStarted?.();
                audio.play().catch((err) => {
                  addLog?.(
                    "error",
                    "TTS",
                    `audio.play() blocked: ${err?.message ?? err} — unlock audio by clicking Start Interview`
                  );
                });
              }
            }
          } catch (err) {
            if (signal.aborted) {
              hardTeardown();
              if (!settled) {
                settled = true;
                resolve({ aborted: true });
              }
              return;
            }
            hardTeardown();
            if (!settled) {
              settled = true;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
      },
      { once: true }
    );

    audio.oncanplay = () => {
      if (!audio.paused) return;
      onPlaybackStarted?.();
      audio.play().catch((err) => {
        addLog?.(
          "error",
          "TTS",
          `oncanplay play() blocked: ${err?.message ?? err}`
        );
      });
    };

    audio.onended = () => {
      safetyCleanup();
      audioRef.current = null;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      addLog?.("success", "TTS", "Playback finished");
      if (!settled) {
        settled = true;
        resolve({ aborted: false });
      }
    };

    audio.onerror = () => {
      safetyCleanup();
      audioRef.current = null;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      addLog?.("error", "TTS", "Playback error");
      if (!settled) {
        settled = true;
        reject(new Error("Audio playback error"));
      }
    };

    audio.play().catch(() => {});
  });
}

async function blobPlayControlled(
  audioUrl: string,
  addLog: AddLog | undefined,
  signal: AbortSignal,
  audioRef: MutableRefObject<HTMLAudioElement | null>,
  onPlaybackStarted?: () => void
): Promise<SpeakPlaybackResult> {
  const audio = new Audio(audioUrl);
  audioRef.current = audio;

  return new Promise((resolve, reject) => {
    const maxDuration = 60000;
    const safetyTimer = setTimeout(() => {
      addLog?.(
        "warn",
        "TTS",
        "Audio onended never fired — safety timeout, continuing"
      );
      audioRef.current = null;
      URL.revokeObjectURL(audioUrl);
      resolve({ aborted: false });
    }, maxDuration);

    const abortHandler = () => {
      clearTimeout(safetyTimer);
      audio.pause();
      audio.src = "";
      audioRef.current = null;
      URL.revokeObjectURL(audioUrl);
      resolve({ aborted: true });
    };

    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });

    audio.onended = () => {
      signal.removeEventListener("abort", abortHandler);
      clearTimeout(safetyTimer);
      audioRef.current = null;
      URL.revokeObjectURL(audioUrl);
      addLog?.("success", "TTS", "Playback finished");
      resolve({ aborted: false });
    };
    audio.onerror = () => {
      signal.removeEventListener("abort", abortHandler);
      clearTimeout(safetyTimer);
      audioRef.current = null;
      URL.revokeObjectURL(audioUrl);
      addLog?.("error", "TTS", "Playback error");
      reject(new Error("Audio playback error"));
    };

    audio
      .play()
      .then(() => {
        onPlaybackStarted?.();
      })
      .catch((err) => {
        signal.removeEventListener("abort", abortHandler);
        clearTimeout(safetyTimer);
        audioRef.current = null;
        URL.revokeObjectURL(audioUrl);
        addLog?.("error", "TTS", `audio.play() failed: ${err?.message ?? err}`);
        reject(err);
      });
  });
}
