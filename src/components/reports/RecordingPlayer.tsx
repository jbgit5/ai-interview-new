"use client";

import { useState } from "react";
import { Play, Video, AlertCircle } from "lucide-react";

interface RecordingPlayerProps {
  sessionId: string;
}

export default function RecordingPlayer({ sessionId }: RecordingPlayerProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const src = `/api/recordings/${sessionId}/stream`;

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
        <AlertCircle className="h-4 w-4 shrink-0 text-gray-400" />
        No recording available for this session.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2.5">
        <Video className="h-3.5 w-3.5 text-violet-500" />
        <span className="text-xs font-semibold text-gray-700">Interview Recording</span>
        {!loaded && (
          <span className="ml-auto text-xs text-gray-400">Click to load</span>
        )}
      </div>

      {/* Video — fixed height, fits right column width */}
      <div className="relative w-full bg-gray-950" style={{ height: "190px" }}>
        {!loaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-950">
            <button
              onClick={() => setLoaded(true)}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 hover:bg-violet-700 transition-colors shadow-md"
            >
              <Play className="h-5 w-5 fill-white text-white" />
            </button>
            <p className="text-xs text-gray-500">Click to load recording</p>
          </div>
        )}
        {loaded && (
          <video
            className="absolute inset-0 h-full w-full object-contain bg-black"
            controls
            autoPlay
            onError={() => setError(true)}
            src={src}
          />
        )}
      </div>
    </div>
  );
}
