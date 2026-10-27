"use client";

import { useState, useEffect, useRef } from "react";
import type { AIStatus } from "@/hooks/useInterview";
import { useSimliAvatar } from "@/hooks/useSimliAvatar";
import {
  INTERVIEW_AVATAR_CHANGED_EVENT,
  normalizeInterviewerAvatarId,
  type InterviewerAvatarId,
} from "@/lib/interviewerAvatar";

/** Wiring for the lip-sync avatar (only used by the "real" avatar on the GPT-Live engine). */
export interface SimliAvatarProps {
  interviewToken: string;
  /** Maya's incoming GPT-Live audio track. */
  audioTrack: MediaStreamTrack | null;
  /** True only while the interview is running on the GPT-Live engine. */
  enabled: boolean;
  /** true = avatar is visibly rendering, parent should mute raw audio; false = unmute. */
  onActiveChange: (active: boolean) => void;
  onTelemetry?: (eventName: string, attrs?: Record<string, unknown>) => void;
  /** Simli's speaking/silent events (what the candidate still sees and hears). */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Context for the "provider stopped us" diagnostic. */
  getDebugContext?: () => Record<string, unknown>;
  /** The candidate has clicked Start (placeholder text changes; photo fallback becomes possible). */
  interviewStarted: boolean;
}

interface MayaAvatarProps {
  status: AIStatus;
  size?: "sm" | "md" | "lg";
  /** Recruiter default from `/api/sessions/.../start` — wins over localStorage (candidate browsers). */
  serverAvatarId?: InterviewerAvatarId | null;
  /** Optional lip-sync wiring; ignored by the cartoon avatars. */
  simli?: SimliAvatarProps;
  /** "circle" = classic ring avatar; "tile" = fills a Meet-style video tile. */
  variant?: "circle" | "tile";
}

const SIZE = { sm: 100, md: 160, lg: 220 };

// ── Shared ring + wrapper layout ─────────────────────────────────────────────

function AvatarShell({
  status,
  px,
  ringColors,     // [speaking, listening, thinking, waiting]
  conicColors,    // conic-gradient string per state
  name,
  children,
  blinkKey,
}: {
  status: AIStatus;
  px: number;
  ringColors: [string, string, string, string];
  conicColors: [string, string, string, string];
  name: string;
  children: React.ReactNode;
  blinkKey: string;
}) {
  const idx = status === "speaking" ? 0 : status === "listening" ? 1 : status === "thinking" ? 2 : 3;
  const rc  = ringColors[idx];
  const cc  = conicColors[idx];
  const isWaiting = status === "waiting";

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: px + 32 }}>
      <div className="relative" style={{ width: px, height: px }}>
        {!isWaiting && (
          <span className="absolute inset-0 rounded-full opacity-40"
            style={{ background: `radial-gradient(circle, ${rc}33 0%, transparent 70%)`, animation: "asPing 1.8s ease-in-out infinite", border: `2px solid ${rc}` }} />
        )}
        <div className="absolute rounded-full"
          style={{ inset: -3, background: cc, animation: isWaiting ? "none" : "asSpin 3s linear infinite", borderRadius: "50%" }} />
        <div className="absolute rounded-full"
          style={{ inset: 3, background: "#0f172a", borderRadius: "50%", zIndex: 1 }} />
        <div className="absolute overflow-hidden rounded-full"
          style={{ inset: 4, zIndex: 2, background: "linear-gradient(145deg, #1e293b 0%, #0f172a 100%)", boxShadow: isWaiting ? "none" : `0 0 24px ${rc}99` }}>
          {children}
        </div>
      </div>

      <div className="text-center">
        <p className="text-sm font-semibold text-white tracking-wide">{name}</p>
        <p className="text-xs mt-0.5 font-medium transition-colors duration-500" style={{ color: rc }}>
          {status === "speaking" ? "Speaking…" : status === "listening" ? "Listening…" : status === "thinking" ? "Thinking…" : "AI Interviewer"}
        </p>

        {(status === "speaking" || status === "listening") && (
          <div className="mt-1.5 flex items-end justify-center gap-0.5" style={{ height: 16 }}>
            {[40, 70, 100, 60, 35].map((h, i) => (
              <div key={i} className="w-1 rounded-full" style={{ height: `${h}%`, background: rc, animation: "asBar 0.9s ease-in-out infinite alternate", animationDelay: `${i * 0.13}s` }} />
            ))}
          </div>
        )}
        {status === "thinking" && (
          <div className="mt-1.5 flex items-center justify-center gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: rc, animation: "bounce 1s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes asSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes asPing  { 0%{transform:scale(1);opacity:0.5} 70%{transform:scale(1.15);opacity:0} 100%{transform:scale(1);opacity:0} }
        @keyframes asBar   { from{transform:scaleY(0.25);opacity:0.5} to{transform:scaleY(1);opacity:1} }
        @keyframes ${blinkKey} { 0%,88%,100%{transform:scaleY(1)} 92%{transform:scaleY(0.08)} }
        @keyframes asTalk  { from{transform:scaleY(0.5)} to{transform:scaleY(1)} }
      `}</style>
    </div>
  );
}

// ── Maya SVG ─────────────────────────────────────────────────────────────────

function MayaFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isListening = status === "listening";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Maya"
      blinkKey="mayaBlink"
      ringColors={["#3b82f6","#22c55e","#f59e0b","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#3b82f6,#8b5cf6,#06b6d4,#3b82f6)",
        "conic-gradient(from 0deg,#22c55e,#06b6d4,#22c55e)",
        "conic-gradient(from 0deg,#f59e0b,#ef4444,#f59e0b)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="mSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f5cba7"/><stop offset="70%" stopColor="#e0a070"/><stop offset="100%" stopColor="#c47a45"/></radialGradient>
          <radialGradient id="mEye"  cx="38%" cy="32%" r="62%"><stop offset="0%" stopColor="#6b3a1f"/><stop offset="100%" stopColor="#1a0a00"/></radialGradient>
          <radialGradient id="mBg"   cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1e3a5f"/><stop offset="100%" stopColor="#071525"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#mBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#1d4ed8"/>
        <path d="M 20 96 Q 30 85 42 90 L 50 96 L 58 90 Q 70 85 80 96 L 90 106 L 10 106 Z" fill="#2563eb"/>
        <path d="M 42 90 L 50 96 L 58 90 L 55 97 L 50 102 L 45 97 Z" fill="#1e40af"/>
        <ellipse cx="50" cy="90" rx="11" ry="9" fill="url(#mSkin)"/>
        <ellipse cx="50" cy="52" rx="26" ry="30" fill="url(#mSkin)"/>
        <ellipse cx="50" cy="23" rx="27" ry="14" fill="#1a0a00"/>
        <ellipse cx="50" cy="21" rx="25" ry="11" fill="#2d1306"/>
        <path d="M 24 30 Q 19 50 21 68 Q 23 58 26 48 Z" fill="#1a0a00"/>
        <path d="M 76 30 Q 81 50 79 68 Q 77 58 74 48 Z" fill="#1a0a00"/>
        <path d="M 32 18 Q 50 12 68 18 Q 50 9 32 18" fill="#3d1a08" opacity="0.6"/>
        <circle cx="24" cy="55" r="2.5" fill="#f59e0b"/><ellipse cx="24" cy="60" rx="1.8" ry="3" fill="#f59e0b"/>
        <circle cx="76" cy="55" r="2.5" fill="#f59e0b"/><ellipse cx="76" cy="60" rx="1.8" ry="3" fill="#f59e0b"/>
        <path d="M 31 41 Q 38 37 44 40" stroke="#1a0a00" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"37px 39px"}:{}}/>
        <path d="M 56 40 Q 62 37 69 41" stroke="#1a0a00" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"63px 39px"}:{}}/>
        <g style={{animation:"mayaBlink 5s ease-in-out infinite",transformOrigin:"37px 49px"}}>
          <ellipse cx="37" cy="49" rx="6.5" ry="7" fill="white"/>
          <circle cx="38" cy="49" r="4.5" fill="url(#mEye)"/>
          <circle cx="36.5" cy="47" r="1.5" fill="white" opacity="0.6"/>
          {isListening&&<circle cx="38" cy="49" r="4.5" fill="#22c55e" opacity="0.3"/>}
        </g>
        <g style={{animation:"mayaBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 49px"}}>
          <ellipse cx="63" cy="49" rx="6.5" ry="7" fill="white"/>
          <circle cx="62" cy="49" r="4.5" fill="url(#mEye)"/>
          <circle cx="60.5" cy="47" r="1.5" fill="white" opacity="0.6"/>
          {isListening&&<circle cx="62" cy="49" r="4.5" fill="#22c55e" opacity="0.3"/>}
        </g>
        <path d="M 49 55 Q 47 62 45 63 Q 50 65 55 63 Q 53 62 51 55" fill="none" stroke="#c47a45" strokeWidth="1.2" strokeLinecap="round"/>
        <ellipse cx="30" cy="63" rx="7" ry="4" fill="#f9a8a8" opacity="0.35"/>
        <ellipse cx="70" cy="63" rx="7" ry="4" fill="#f9a8a8" opacity="0.35"/>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 72 Q 50 80 61 72" fill="#c0392b"/>
            <path d="M 42 72 Q 50 77 58 72" fill="white"/>
          </g>
        ) : isListening ? (
          <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#c0392b" strokeWidth="2.2" strokeLinecap="round"/>
        ) : isThinking ? (
          <path d="M 41 71 Q 52 70 60 72" fill="none" stroke="#c47a45" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 41 72 Q 50 78 59 72" fill="none" stroke="#c0392b" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Alex SVG ──────────────────────────────────────────────────────────────────

function AlexFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Alex"
      blinkKey="alexBlink"
      ringColors={["#8b5cf6","#06b6d4","#f59e0b","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#8b5cf6,#ec4899,#8b5cf6)",
        "conic-gradient(from 0deg,#06b6d4,#22c55e,#06b6d4)",
        "conic-gradient(from 0deg,#f59e0b,#f43f5e,#f59e0b)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="aSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#fde68a"/><stop offset="100%" stopColor="#d97706"/></radialGradient>
          <radialGradient id="aBg"   cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#2d1b69"/><stop offset="100%" stopColor="#0f0720"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#aBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#7c3aed"/>
        <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#6d28d9"/>
        <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#aSkin)"/>
        <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#aSkin)"/>
        <ellipse cx="50" cy="26" rx="27" ry="12" fill="#92400e"/>
        <ellipse cx="50" cy="24" rx="25" ry="9" fill="#b45309"/>
        <path d="M 24 28 Q 20 38 23 50 Q 25 44 27 38 Z" fill="#92400e"/>
        <path d="M 76 28 Q 80 38 77 50 Q 75 44 73 38 Z" fill="#92400e"/>
        {/* Glasses frames */}
        <circle cx="37" cy="48" r="9" fill="none" stroke="#1e293b" strokeWidth="2" opacity="0.75"/>
        <circle cx="63" cy="48" r="9" fill="none" stroke="#1e293b" strokeWidth="2" opacity="0.75"/>
        <path d="M 46 48 L 54 48" stroke="#1e293b" strokeWidth="2" opacity="0.75"/>
        <path d="M 28 48 L 23 46" stroke="#1e293b" strokeWidth="1.5" opacity="0.6"/>
        <path d="M 72 48 L 77 46" stroke="#1e293b" strokeWidth="1.5" opacity="0.6"/>
        <g style={{animation:"alexBlink 5s ease-in-out infinite",transformOrigin:"37px 48px"}}>
          <ellipse cx="37" cy="48" rx="5.8" ry="6" fill="white"/>
          <circle cx="38" cy="48" r="3.8" fill="#1a3a6a"/>
          <circle cx="36.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
        </g>
        <g style={{animation:"alexBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 48px"}}>
          <ellipse cx="63" cy="48" rx="5.8" ry="6" fill="white"/>
          <circle cx="62" cy="48" r="3.8" fill="#1a3a6a"/>
          <circle cx="60.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
        </g>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 71 Q 50 80 61 71" fill="#b45309"/>
          </g>
        ) : isThinking ? (
          <path d="M 41 71 Q 52 70 60 72" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#b45309" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Sam SVG ───────────────────────────────────────────────────────────────────

function SamFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Sam"
      blinkKey="samBlink"
      ringColors={["#10b981","#f97316","#a855f7","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#10b981,#3b82f6,#10b981)",
        "conic-gradient(from 0deg,#f97316,#f43f5e,#f97316)",
        "conic-gradient(from 0deg,#a855f7,#ec4899,#a855f7)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="sSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#c8917a"/><stop offset="100%" stopColor="#8b5040"/></radialGradient>
          <radialGradient id="sBg"   cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0f3326"/><stop offset="100%" stopColor="#041a10"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#sBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#065f46"/>
        <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#047857"/>
        <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#sSkin)"/>
        <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#sSkin)"/>
        {/* Curly hair */}
        <ellipse cx="50" cy="24" rx="28" ry="14" fill="#1a0a00"/>
        {[0,20,40,60,80,100,120,140,160].map((deg, i) => (
          <circle key={i} cx={50 + 26*Math.cos((deg-90)*Math.PI/180)} cy={24 + 12*Math.sin((deg-90)*Math.PI/180)} r="5" fill="#1a0a00"/>
        ))}
        <ellipse cx="50" cy="22" rx="24" ry="10" fill="#2d1306"/>
        <g style={{animation:"samBlink 5s ease-in-out infinite",transformOrigin:"37px 48px"}}>
          <ellipse cx="37" cy="48" rx="6" ry="6.5" fill="white"/>
          <circle cx="38" cy="48" r="4" fill="#3d1010"/>
          <circle cx="36.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
        </g>
        <g style={{animation:"samBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 48px"}}>
          <ellipse cx="63" cy="48" rx="6" ry="6.5" fill="white"/>
          <circle cx="62" cy="48" r="4" fill="#3d1010"/>
          <circle cx="60.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
        </g>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 70 Q 50 80 61 70" fill="#7f3030"/>
          </g>
        ) : isThinking ? (
          <path d="M 41 71 Q 52 70 60 72" fill="none" stroke="#8b5040" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#7f3030" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Jordan SVG ────────────────────────────────────────────────────────────────

function JordanFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Jordan"
      blinkKey="jordanBlink"
      ringColors={["#f43f5e","#38bdf8","#facc15","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#f43f5e,#f97316,#f43f5e)",
        "conic-gradient(from 0deg,#38bdf8,#818cf8,#38bdf8)",
        "conic-gradient(from 0deg,#facc15,#f97316,#facc15)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="jSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#e8c9a0"/><stop offset="100%" stopColor="#b8834a"/></radialGradient>
          <radialGradient id="jBg"   cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1c1520"/><stop offset="100%" stopColor="#080510"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#jBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#9f1239"/>
        <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#881337"/>
        <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#jSkin)"/>
        <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#jSkin)"/>
        <rect x="23" y="16" width="54" height="22" rx="8" fill="#111827"/>
        <rect x="23" y="24" width="8" height="32" rx="4" fill="#111827"/>
        <rect x="69" y="24" width="8" height="32" rx="4" fill="#111827"/>
        <path d="M 29 40 Q 38 36 44 38" stroke="#111827" strokeWidth="2.8" fill="none" strokeLinecap="round"/>
        <path d="M 56 38 Q 62 36 71 40" stroke="#111827" strokeWidth="2.8" fill="none" strokeLinecap="round"/>
        <g style={{animation:"jordanBlink 5s ease-in-out infinite",transformOrigin:"37px 48px"}}>
          <ellipse cx="37" cy="48" rx="6" ry="6.5" fill="white"/>
          <circle cx="38" cy="48" r="4.2" fill="#1a0a00"/>
          <circle cx="36.5" cy="46.5" r="1.3" fill="white" opacity="0.6"/>
        </g>
        <g style={{animation:"jordanBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 48px"}}>
          <ellipse cx="63" cy="48" rx="6" ry="6.5" fill="white"/>
          <circle cx="62" cy="48" r="4.2" fill="#1a0a00"/>
          <circle cx="60.5" cy="46.5" r="1.3" fill="white" opacity="0.6"/>
        </g>
        {/* Beard */}
        <ellipse cx="50" cy="75" rx="17" ry="7" fill="#b8834a" opacity="0.35"/>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 71 Q 50 81 61 71" fill="#7f3030"/>
          </g>
        ) : isThinking ? (
          <path d="M 41 71 Q 52 70 60 72" fill="none" stroke="#b8834a" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 40 71 Q 50 76 60 71" fill="none" stroke="#9f3030" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Priya Face ────────────────────────────────────────────────────────────────

function PriyaFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Priya"
      blinkKey="priyaBlink"
      ringColors={["#ec4899","#06b6d4","#f59e0b","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#ec4899,#f97316,#ec4899)",
        "conic-gradient(from 0deg,#06b6d4,#0ea5e9,#06b6d4)",
        "conic-gradient(from 0deg,#f59e0b,#ef4444,#f59e0b)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="prSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f4a261"/><stop offset="70%" stopColor="#e08050"/><stop offset="100%" stopColor="#c97040"/></radialGradient>
          <radialGradient id="prBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1a0a2e"/><stop offset="100%" stopColor="#0a0418"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#prBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#0f766e"/>
        <path d="M 20 96 Q 30 85 42 90 L 50 96 L 58 90 Q 70 85 80 96 L 90 106 L 10 106 Z" fill="#0d9488"/>
        <path d="M 42 90 L 50 96 L 58 90 L 55 97 L 50 102 L 45 97 Z" fill="#0f766e"/>
        <ellipse cx="50" cy="90" rx="11" ry="9" fill="url(#prSkin)"/>
        <ellipse cx="50" cy="52" rx="25" ry="29" fill="url(#prSkin)"/>
        {/* Long hair with centre part */}
        <ellipse cx="50" cy="22" rx="27" ry="13" fill="#1a0505"/>
        <path d="M 50 15 L 50 92" stroke="#1a0505" strokeWidth="5"/>
        <path d="M 24 30 Q 19 55 21 75 Q 23 60 26 46 Z" fill="#1a0505"/>
        <path d="M 76 30 Q 81 55 79 75 Q 77 60 74 46 Z" fill="#1a0505"/>
        <path d="M 21 75 Q 27 88 38 88 L 21 75" fill="#1a0505"/>
        <path d="M 79 75 Q 73 88 62 88 L 79 75" fill="#1a0505"/>
        {/* Bindi */}
        <circle cx="50" cy="38" r="3" fill="#ec4899" style={{ filter: "drop-shadow(0 0 3px #ec4899)" }}/>
        {/* Eyebrows */}
        <path d="M 30 43 Q 38 39 44 42" stroke="#1a0505" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"37px 41px"}:{}}/>
        <path d="M 56 42 Q 62 39 70 43" stroke="#1a0505" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"63px 41px"}:{}}/>
        {/* Eyes */}
        <g style={{animation:"priyaBlink 5s ease-in-out infinite",transformOrigin:"37px 50px"}}>
          <ellipse cx="37" cy="50" rx="6.5" ry="7" fill="white"/>
          <circle cx="38" cy="50" r="4.5" fill="#1a0505"/>
          <circle cx="36.5" cy="48.5" r="1.4" fill="white" opacity="0.6"/>
        </g>
        <g style={{animation:"priyaBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 50px"}}>
          <ellipse cx="63" cy="50" rx="6.5" ry="7" fill="white"/>
          <circle cx="62" cy="50" r="4.5" fill="#1a0505"/>
          <circle cx="60.5" cy="48.5" r="1.4" fill="white" opacity="0.6"/>
        </g>
        {/* Kohl / eyeliner */}
        <path d="M 30 50 Q 37 47 44 50" stroke="#1a0505" strokeWidth="1" fill="none" opacity="0.5"/>
        <path d="M 56 50 Q 63 47 70 50" stroke="#1a0505" strokeWidth="1" fill="none" opacity="0.5"/>
        <path d="M 49 56 Q 47 62 45 63 Q 50 65 55 63 Q 53 62 51 56" fill="none" stroke="#c97040" strokeWidth="1.2" strokeLinecap="round"/>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 72 Q 50 81 61 72" fill="#c0392b"/>
            <path d="M 42 72 Q 50 77 58 72" fill="white"/>
          </g>
        ) : isThinking ? (
          <path d="M 41 71 Q 52 70 60 72" fill="none" stroke="#c97040" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 40 72 Q 50 78 60 72" fill="none" stroke="#c0392b" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Zara Face ─────────────────────────────────────────────────────────────────

function ZaraFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Zara"
      blinkKey="zaraBlink"
      ringColors={["#38bdf8","#34d399","#a78bfa","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#38bdf8,#6366f1,#38bdf8)",
        "conic-gradient(from 0deg,#34d399,#06b6d4,#34d399)",
        "conic-gradient(from 0deg,#a78bfa,#ec4899,#a78bfa)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="zrSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#d4a373"/><stop offset="100%" stopColor="#a07040"/></radialGradient>
          <radialGradient id="zrBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0c1a2e"/><stop offset="100%" stopColor="#050e1a"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#zrBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#1e3a5f"/>
        <path d="M 20 96 Q 30 85 42 90 L 50 96 L 58 90 Q 70 85 80 96 L 90 106 L 10 106 Z" fill="#1d4ed8"/>
        <path d="M 42 90 L 50 96 L 58 90 L 55 97 L 50 102 L 45 97 Z" fill="#1e3a5f"/>
        {/* Hijab — teal/navy */}
        <path d="M 22 40 Q 20 62 22 82 Q 30 90 50 91 Q 70 90 78 82 Q 80 62 78 40 Q 65 18 50 16 Q 35 18 22 40 Z" fill="#0f766e"/>
        <path d="M 22 40 Q 30 26 50 22 Q 70 26 78 40 Q 70 34 50 31 Q 30 34 22 40 Z" fill="#0d9488"/>
        {/* Lighter drape fold */}
        <path d="M 22 82 Q 28 92 50 93 Q 72 92 78 82 Q 70 87 50 88 Q 30 87 22 82" fill="#115e59" opacity="0.6"/>
        <ellipse cx="50" cy="54" rx="22" ry="24" fill="url(#zrSkin)"/>
        <path d="M 31 46 Q 38 42 44 45" stroke="#2d1a00" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"37px 44px"}:{}}/>
        <path d="M 56 45 Q 62 42 69 46" stroke="#2d1a00" strokeWidth="2" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"63px 44px"}:{}}/>
        <g style={{animation:"zaraBlink 5s ease-in-out infinite",transformOrigin:"38px 52px"}}>
          <ellipse cx="38" cy="52" rx="6" ry="6.5" fill="white"/>
          <circle cx="39" cy="52" r="4.2" fill="#2d1a00"/>
          <circle cx="37.5" cy="50.5" r="1.3" fill="white" opacity="0.6"/>
        </g>
        <g style={{animation:"zaraBlink 5s ease-in-out infinite 0.1s",transformOrigin:"62px 52px"}}>
          <ellipse cx="62" cy="52" rx="6" ry="6.5" fill="white"/>
          <circle cx="61" cy="52" r="4.2" fill="#2d1a00"/>
          <circle cx="59.5" cy="50.5" r="1.3" fill="white" opacity="0.6"/>
        </g>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 40 66 Q 50 75 60 66" fill="#9b3030"/>
          </g>
        ) : isThinking ? (
          <path d="M 41 66 Q 52 65 60 67" fill="none" stroke="#a07040" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 41 66 Q 50 72 59 66" fill="none" stroke="#9b3030" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Chen Face ─────────────────────────────────────────────────────────────────

function ChenFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking = status === "speaking";
  const isThinking = status === "thinking";
  return (
    <AvatarShell status={status} px={px} name="Chen"
      blinkKey="chenBlink"
      ringColors={["#f97316","#22d3ee","#e879f9","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#f97316,#64748b,#f97316)",
        "conic-gradient(from 0deg,#22d3ee,#38bdf8,#22d3ee)",
        "conic-gradient(from 0deg,#e879f9,#a855f7,#e879f9)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
        <defs>
          <radialGradient id="chSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f8d7b0"/><stop offset="70%" stopColor="#e5ba90"/><stop offset="100%" stopColor="#d4a070"/></radialGradient>
          <radialGradient id="chBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#111827"/><stop offset="100%" stopColor="#030712"/></radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#chBg)"/>
        <ellipse cx="50" cy="102" rx="38" ry="20" fill="#1f2937"/>
        <path d="M 20 96 Q 30 85 42 90 L 50 96 L 58 90 Q 70 85 80 96 L 90 106 L 10 106 Z" fill="#374151"/>
        <path d="M 42 90 L 50 96 L 58 90 L 55 97 L 50 102 L 45 97 Z" fill="#1f2937"/>
        <ellipse cx="50" cy="90" rx="11" ry="9" fill="url(#chSkin)"/>
        <ellipse cx="50" cy="52" rx="24" ry="27" fill="url(#chSkin)"/>
        {/* Short neat black hair */}
        <path d="M 24 32 Q 26 16 50 14 Q 74 16 76 32 Q 72 22 50 20 Q 28 22 24 32 Z" fill="#0a0a0a"/>
        <rect x="23" y="26" width="54" height="10" rx="5" fill="#0a0a0a"/>
        {/* Slight eye fold */}
        <path d="M 30 47 Q 37 44 44 47" stroke="#8b6a50" strokeWidth="1.2" fill="none" opacity="0.6"/>
        <path d="M 56 47 Q 63 44 70 47" stroke="#8b6a50" strokeWidth="1.2" fill="none" opacity="0.6"/>
        <path d="M 31 42 Q 38 39 44 41" stroke="#0a0a0a" strokeWidth="1.8" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"37px 41px"}:{}}/>
        <path d="M 56 41 Q 62 39 69 42" stroke="#0a0a0a" strokeWidth="1.8" fill="none" strokeLinecap="round" style={isThinking?{transform:"translateY(-2px)",transformOrigin:"63px 41px"}:{}}/>
        <g style={{animation:"chenBlink 5s ease-in-out infinite",transformOrigin:"37px 50px"}}>
          <ellipse cx="37" cy="50" rx="6.8" ry="5.8" fill="white"/>
          <circle cx="38" cy="50" r="4" fill="#0a0a0a"/>
          <circle cx="36.8" cy="48.8" r="1.2" fill="white" opacity="0.7"/>
        </g>
        <g style={{animation:"chenBlink 5s ease-in-out infinite 0.1s",transformOrigin:"63px 50px"}}>
          <ellipse cx="63" cy="50" rx="6.8" ry="5.8" fill="white"/>
          <circle cx="62" cy="50" r="4" fill="#0a0a0a"/>
          <circle cx="60.8" cy="48.8" r="1.2" fill="white" opacity="0.7"/>
        </g>
        <path d="M 49 56 Q 47 62 45 63 Q 50 65 55 63 Q 53 62 51 56" fill="none" stroke="#d4a070" strokeWidth="1.2" strokeLinecap="round"/>
        {isSpeaking ? (
          <g style={{animation:"asTalk 0.4s ease-in-out infinite alternate"}}>
            <path d="M 39 71 Q 50 80 61 71" fill="#8b3030"/>
            <path d="M 42 71 Q 50 76 58 71" fill="white"/>
          </g>
        ) : isThinking ? (
          <path d="M 42 70 Q 52 69 60 71" fill="none" stroke="#d4a070" strokeWidth="2" strokeLinecap="round"/>
        ) : (
          <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#8b3030" strokeWidth="2.2" strokeLinecap="round"/>
        )}
      </svg>
    </AvatarShell>
  );
}

// ── Real-person face (photo + optional Simli lip-sync video) ──────────────────

const noopActive = () => {};

/** Neutral "Maya" tile shown until her live face is ready — never a still photo that then jumps. */
function MayaPlaceholder({ text, busy, compact }: { text: string; busy: boolean; compact?: boolean }) {
  return (
    <div
      style={{ position: "absolute", inset: 0 }}
      className="flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-slate-800 to-slate-900"
    >
      <div
        className={`flex items-center justify-center rounded-full font-semibold text-white ${
          compact ? "h-14 w-14 text-xl" : "h-24 w-24 text-4xl"
        } ${busy ? "animate-pulse" : ""}`}
        style={{ background: "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)" }}
      >
        M
      </div>
      {!compact && <p className="px-4 text-center text-sm text-slate-300">{text}</p>}
    </div>
  );
}

function RealFace({
  status,
  px,
  simli,
  variant = "circle",
}: {
  status: AIStatus;
  px: number;
  simli?: SimliAvatarProps;
  variant?: "circle" | "tile";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const { phase } = useSimliAvatar({
    interviewToken: simli?.interviewToken ?? "",
    audioTrack: simli?.audioTrack ?? null,
    enabled: !!simli?.enabled,
    videoRef,
    audioRef,
    onActiveChange: simli?.onActiveChange ?? noopActive,
    onTelemetry: simli?.onTelemetry,
    onSpeakingChange: simli?.onSpeakingChange,
    getDebugContext: simli?.getDebugContext,
  });
  const rendering = phase === "active";
  const started = !!simli?.interviewStarted;
  // The still photo is ONLY a fallback: the live face failed, or this interview runs on the standard
  // engine (no GPT-Live audio to lip-sync). Before Start, and while connecting, a neutral placeholder
  // shows instead — the photo-then-jump-to-video switch looked like two different people.
  const showPhoto = !rendering && (phase === "failed" || (started && !simli?.enabled));
  const showPlaceholder = !rendering && !showPhoto;

  const content = (
      <div style={{ position: "relative", width: "100%", height: "100%", background: "#0f172a" }}>
        {showPhoto && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "url(/avatars/maya-real.webp)",
              backgroundSize: variant === "tile" ? "cover" : "auto 118%",
              backgroundPosition: variant === "tile" ? "50% 25%" : "50% 18%",
              backgroundRepeat: "no-repeat",
            }}
          />
        )}
        {showPlaceholder && (
          <MayaPlaceholder
            text={started ? "Maya is joining…" : "Maya will join when you start"}
            busy={started}
            compact={variant === "circle"}
          />
        )}
        {/* Lip-synced video fades in only once Simli is visibly rendering. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: rendering ? 1 : 0,
            transition: "opacity 300ms ease",
          }}
        />
        <audio ref={audioRef} autoPlay />
      </div>
  );

  if (variant === "tile") return content;
  return (
    <AvatarShell status={status} px={px} name="Maya"
      blinkKey="realBlink"
      ringColors={["#3b82f6","#22c55e","#f59e0b","#475569"]}
      conicColors={[
        "conic-gradient(from 0deg,#3b82f6,#8b5cf6,#06b6d4,#3b82f6)",
        "conic-gradient(from 0deg,#22c55e,#06b6d4,#22c55e)",
        "conic-gradient(from 0deg,#f59e0b,#ef4444,#f59e0b)",
        "conic-gradient(from 0deg,#475569,#334155,#475569)",
      ]}
    >
      {content}
    </AvatarShell>
  );
}

// ── Nova Face (AI Robot) ──────────────────────────────────────────────────────

function NovaFace({ status, px }: { status: AIStatus; px: number }) {
  const isSpeaking  = status === "speaking";
  const isListening = status === "listening";
  const isThinking  = status === "thinking";

  // Nova's ring colours are distinct — faster spin for tech feel
  const ringColor = isSpeaking ? "#a855f7" : isListening ? "#22d3ee" : isThinking ? "#facc15" : "#334155";
  const eyeColor  = isSpeaking ? "#c084fc" : isListening ? "#67e8f9" : isThinking ? "#fde047" : "#94a3b8";
  const isWaiting = status === "waiting";

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: px + 32 }}>
      <div className="relative" style={{ width: px, height: px }}>
        {!isWaiting && (
          <span className="absolute inset-0 rounded-full opacity-40"
            style={{ background: `radial-gradient(circle, ${ringColor}33 0%, transparent 70%)`, animation: "asPing 1.8s ease-in-out infinite", border: `2px solid ${ringColor}` }} />
        )}
        <div className="absolute rounded-full"
          style={{ inset: -3, background: `conic-gradient(from 0deg,${ringColor},#0ea5e9,${ringColor})`, animation: isWaiting ? "none" : "novaFastSpin 1.5s linear infinite", borderRadius: "50%" }} />
        <div className="absolute rounded-full"
          style={{ inset: 3, background: "#020617", borderRadius: "50%", zIndex: 1 }} />
        <div className="absolute overflow-hidden rounded-full"
          style={{ inset: 4, zIndex: 2, background: "linear-gradient(145deg, #0f172a 0%, #020617 100%)", boxShadow: isWaiting ? "none" : `0 0 30px ${ringColor}66` }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%", display:"block" }}>
            <defs>
              <radialGradient id="nvBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0f172a"/><stop offset="100%" stopColor="#020617"/></radialGradient>
              <radialGradient id="nvFace" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#1e293b"/><stop offset="100%" stopColor="#0f172a"/></radialGradient>
              <filter id="nvGlow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#nvBg)"/>
            {/* Circuit trace decoration */}
            <path d="M 8 28 L 22 28 L 22 38" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            <path d="M 92 72 L 78 72 L 78 62" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            <circle cx="22" cy="38" r="1.8" fill={isListening ? "#22d3ee" : "#1e3a5f"}/>
            <circle cx="78" cy="62" r="1.8" fill={isSpeaking ? "#a855f7" : "#1e3a5f"}/>
            <path d="M 8 72 L 18 72 L 18 60 L 28 60" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            <path d="M 92 28 L 82 28 L 82 40 L 72 40" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            {/* Neck + body */}
            <rect x="38" y="88" width="24" height="14" rx="3" fill="#1e293b" stroke="#334155" strokeWidth="1"/>
            <rect x="22" y="98" width="56" height="6" rx="2" fill="#0f172a"/>
            {/* Collar connector dots */}
            {[0,1,2].map(i => <circle key={i} cx={44 + i*6} cy={95} r="1.2" fill={ringColor} opacity="0.7"/>)}
            {/* Antenna */}
            <line x1="50" y1="8" x2="50" y2="22" stroke="#475569" strokeWidth="2"/>
            <circle cx="50" cy="7" r="3.5" fill={ringColor} style={{ filter: `drop-shadow(0 0 5px ${ringColor})` }}/>
            {/* Robot head - panel style */}
            <path d="M 26 37 L 20 52 L 26 67 L 74 67 L 80 52 L 74 37 Z" fill="url(#nvFace)" stroke="#334155" strokeWidth="1.5"/>
            <path d="M 26 37 L 74 37" stroke="#475569" strokeWidth="1" opacity="0.5"/>
            <path d="M 26 67 L 74 67" stroke="#475569" strokeWidth="1" opacity="0.5"/>
            {/* Side panel screws */}
            <circle cx="28" cy="39" r="1.5" fill="#334155"/>
            <circle cx="72" cy="39" r="1.5" fill="#334155"/>
            <circle cx="28" cy="65" r="1.5" fill="#334155"/>
            <circle cx="72" cy="65" r="1.5" fill="#334155"/>
            {/* Eye sockets */}
            <rect x="30" y="43" width="16" height="12" rx="3" fill="#020617" stroke={eyeColor} strokeWidth="1.5"/>
            <rect x="54" y="43" width="16" height="12" rx="3" fill="#020617" stroke={eyeColor} strokeWidth="1.5"/>
            {/* Eye glows */}
            <rect x="32" y="45" width="12" height="8" rx="2" fill={eyeColor}
              style={{ filter: `drop-shadow(0 0 4px ${eyeColor})`, animation: !isWaiting ? "novaEyePulse 2s ease-in-out infinite" : "none" }}/>
            <rect x="56" y="45" width="12" height="8" rx="2" fill={eyeColor}
              style={{ filter: `drop-shadow(0 0 4px ${eyeColor})`, animation: !isWaiting ? "novaEyePulse 2s ease-in-out infinite 0.3s" : "none" }}/>
            {/* Scanline in eyes */}
            <rect x="32" y="49" width="12" height="1.5" fill="#020617" opacity="0.4"/>
            <rect x="56" y="49" width="12" height="1.5" fill="#020617" opacity="0.4"/>
            {/* Mouth — LED bar */}
            {isSpeaking ? (
              <g style={{ animation: "novaMouth 0.25s steps(3) infinite" }}>
                <rect x="34" y="59" width="32" height="5" rx="2.5" fill={ringColor} style={{ filter: `drop-shadow(0 0 4px ${ringColor})` }}/>
                <rect x="37" y="60.5" width="4" height="2" rx="1" fill="#020617"/>
                <rect x="44" y="60.5" width="4" height="2" rx="1" fill="#020617"/>
                <rect x="51" y="60.5" width="4" height="2" rx="1" fill="#020617"/>
                <rect x="58" y="60.5" width="4" height="2" rx="1" fill="#020617"/>
              </g>
            ) : isListening ? (
              <rect x="34" y="59" width="32" height="5" rx="2.5" fill={eyeColor} opacity="0.7"/>
            ) : (
              <path d="M 36 61.5 L 42 59 L 50 62 L 58 59 L 64 61.5" stroke={eyeColor} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.8"/>
            )}
          </svg>
        </div>
      </div>

      <div className="text-center">
        <p className="text-sm font-semibold text-white tracking-wide">Nova</p>
        <p className="text-xs mt-0.5 font-medium transition-colors duration-500" style={{ color: ringColor }}>
          {isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "AI Interviewer"}
        </p>

        {(isSpeaking || isListening) && (
          <div className="mt-1.5 flex items-end justify-center gap-0.5" style={{ height: 16 }}>
            {[40, 70, 100, 60, 35].map((h, i) => (
              <div key={i} className="w-1 rounded-full" style={{ height: `${h}%`, background: ringColor, animation: "asBar 0.9s ease-in-out infinite alternate", animationDelay: `${i * 0.13}s` }} />
            ))}
          </div>
        )}
        {isThinking && (
          <div className="mt-1.5 flex items-center justify-center gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: ringColor, animation: "bounce 1s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes novaFastSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes novaEyePulse  { 0%,100%{opacity:0.9} 50%{opacity:0.5} }
        @keyframes novaMouth     { 0%{transform:scaleX(1)} 33%{transform:scaleX(0.85)} 66%{transform:scaleX(1.05)} }
      `}</style>
    </div>
  );
}

// ── Main export — reads localStorage to pick avatar ──────────────────────────

export default function MayaAvatar({
  status,
  size = "md",
  serverAvatarId,
  simli,
  variant = "circle",
}: MayaAvatarProps) {
  const px = SIZE[size];
  const resolvedServer = serverAvatarId
    ? normalizeInterviewerAvatarId(serverAvatarId)
    : null;

  const [storedAvatarId, setStoredAvatarId] = useState<InterviewerAvatarId>(
    resolvedServer ?? "maya"
  );

  useEffect(() => {
    function readStored(): InterviewerAvatarId {
      try {
        return normalizeInterviewerAvatarId(localStorage.getItem("avatarId"));
      } catch {
        return "maya";
      }
    }

    function apply() {
      setStoredAvatarId(resolvedServer ?? readStored());
    }

    apply();

    const crossTab = (e: StorageEvent) => {
      if (e.key === "avatarId" && e.newValue) {
        setStoredAvatarId(normalizeInterviewerAvatarId(e.newValue));
      }
    };
    const sameTab = () => apply();

    window.addEventListener("storage", crossTab);
    window.addEventListener(INTERVIEW_AVATAR_CHANGED_EVENT, sameTab);
    return () => {
      window.removeEventListener("storage", crossTab);
      window.removeEventListener(INTERVIEW_AVATAR_CHANGED_EVENT, sameTab);
    };
  }, [resolvedServer]);

  const avatarId = resolvedServer ?? storedAvatarId;

  // The real person fills a whole video tile in the Meet-style room.
  if (avatarId === "real") {
    return <RealFace status={status} px={200} simli={simli} variant={variant} />;
  }

  let face: JSX.Element;
  switch (avatarId) {
    case "alex":   face = <AlexFace   status={status} px={px} />; break;
    case "sam":    face = <SamFace    status={status} px={px} />; break;
    case "jordan": face = <JordanFace status={status} px={px} />; break;
    case "priya":  face = <PriyaFace  status={status} px={px} />; break;
    case "zara":   face = <ZaraFace   status={status} px={px} />; break;
    case "chen":   face = <ChenFace   status={status} px={px} />; break;
    case "nova":   face = <NovaFace   status={status} px={px} />; break;
    default:       face = <MayaFace   status={status} px={px} />;
  }
  // Cartoon avatars sit centred in the tile, like a participant with their camera off.
  return variant === "tile" ? (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-slate-800 to-slate-900">
      {face}
    </div>
  ) : (
    face
  );
}
