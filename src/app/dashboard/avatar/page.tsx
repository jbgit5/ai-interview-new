"use client";

import { useState, useEffect } from "react";
import { Check, Sparkles } from "lucide-react";
import type { AIStatus } from "@/hooks/useInterview";
import {
  INTERVIEW_AVATAR_CHANGED_EVENT,
  normalizeInterviewerAvatarId,
} from "@/lib/interviewerAvatar";

// ── Avatar option definitions ────────────────────────────────────────────────

interface AvatarOption {
  id: string;
  name: string;
  description: string;
  accent: string;          // Tailwind ring colour class
  preview: React.ReactNode;
}

type DemoStatus = AIStatus;

// ── Inline mini-previews for each avatar (self-contained SVGs) ───────────────

function MayaPreview({ status }: { status: DemoStatus }) {
  const isSpeaking  = status === "speaking";
  const isListening = status === "listening";
  const isThinking  = status === "thinking";
  const ringColor   = isSpeaking ? "#3b82f6" : isListening ? "#22c55e" : isThinking ? "#f59e0b" : "#475569";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {!["waiting"].includes(status) && (
          <span className="absolute inset-0 rounded-full opacity-30 animate-ping"
            style={{ border: `2px solid ${ringColor}`, background: `radial-gradient(circle, ${ringColor}22 0%, transparent 70%)` }} />
        )}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg, ${ringColor}, #8b5cf6, ${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex: 2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="mSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f5cba7"/><stop offset="100%" stopColor="#c47a45"/></radialGradient>
              <radialGradient id="mBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1e3a5f"/><stop offset="100%" stopColor="#071525"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#mBg)" />
            <ellipse cx="50" cy="96" rx="38" ry="18" fill="#2563eb"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#1d4ed8"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#mSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#mSkin)"/>
            <ellipse cx="50" cy="24" rx="26" ry="13" fill="#1a0a00"/>
            <ellipse cx="50" cy="22" rx="24" ry="10" fill="#2d1306"/>
            <path d="M 24 28 Q 19 46 22 62 Q 24 54 27 46 Z" fill="#1a0a00"/>
            <path d="M 76 28 Q 81 46 78 62 Q 76 54 73 46 Z" fill="#1a0a00"/>
            <circle cx="24" cy="54" r="2.5" fill="#f59e0b"/>
            <ellipse cx="24" cy="59" rx="1.8" ry="2.8" fill="#f59e0b"/>
            <circle cx="76" cy="54" r="2.5" fill="#f59e0b"/>
            <ellipse cx="76" cy="59" rx="1.8" ry="2.8" fill="#f59e0b"/>
            <g style={{ animation: "blink 5s ease-in-out infinite", transformOrigin:"37px 48px" }}>
              <ellipse cx="37" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="38" cy="48" r="4" fill="#1a0a00"/>
              <circle cx="36.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
            </g>
            <g style={{ animation: "blink 5s ease-in-out infinite 0.1s", transformOrigin:"63px 48px" }}>
              <ellipse cx="63" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="62" cy="48" r="4" fill="#1a0a00"/>
              <circle cx="60.5" cy="46.5" r="1.2" fill="white" opacity="0.6"/>
            </g>
            <path d="M 49 54 Q 47 60 45 61 Q 50 63 55 61 Q 53 60 51 54" fill="none" stroke="#c47a45" strokeWidth="1" strokeLinecap="round"/>
            {isSpeaking
              ? <path d="M 39 70 Q 50 78 61 70" fill="#c0392b" style={{ animation: "talk 0.4s ease-in-out infinite alternate" }}/>
              : <path d="M 40 70 Q 50 76 60 70" fill="none" stroke="#c0392b" strokeWidth="2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Maya</p>
      <p className="text-[10px]" style={{ color: ringColor }}>
        {isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}
      </p>
      <style>{`@keyframes blink{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}} @keyframes talk{from{transform:scaleY(0.5)}to{transform:scaleY(1)}} @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function AlexPreview({ status }: { status: DemoStatus }) {
  const isSpeaking  = status === "speaking";
  const isListening = status === "listening";
  const isThinking  = status === "thinking";
  const ringColor   = isSpeaking ? "#8b5cf6" : isListening ? "#06b6d4" : isThinking ? "#f59e0b" : "#475569";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && (
          <span className="absolute inset-0 rounded-full opacity-30 animate-ping"
            style={{ border: `2px solid ${ringColor}` }} />
        )}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg, ${ringColor}, #ec4899, ${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex: 2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="aSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#fde68a"/><stop offset="100%" stopColor="#d97706"/></radialGradient>
              <radialGradient id="aBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#2d1b69"/><stop offset="100%" stopColor="#0f0720"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#aBg)"/>
            <ellipse cx="50" cy="96" rx="38" ry="18" fill="#7c3aed"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#6d28d9"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#aSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#aSkin)"/>
            {/* Short hair */}
            <ellipse cx="50" cy="26" rx="27" ry="12" fill="#92400e"/>
            <ellipse cx="50" cy="24" rx="25" ry="9" fill="#b45309"/>
            <path d="M 24 28 Q 20 38 23 50 Q 25 44 27 38 Z" fill="#92400e"/>
            <path d="M 76 28 Q 80 38 77 50 Q 75 44 73 38 Z" fill="#92400e"/>
            {/* Glasses */}
            <circle cx="37" cy="48" r="8.5" fill="none" stroke="#1e293b" strokeWidth="1.8" opacity="0.7"/>
            <circle cx="63" cy="48" r="8.5" fill="none" stroke="#1e293b" strokeWidth="1.8" opacity="0.7"/>
            <path d="M 45.5 48 L 54.5 48" stroke="#1e293b" strokeWidth="1.8" opacity="0.7"/>
            <g style={{ animation: "blink2 5s ease-in-out infinite", transformOrigin:"37px 48px" }}>
              <ellipse cx="37" cy="48" rx="5.5" ry="5.8" fill="white"/>
              <circle cx="38" cy="48" r="3.5" fill="#1a3a5f"/>
            </g>
            <g style={{ animation: "blink2 5s ease-in-out infinite 0.1s", transformOrigin:"63px 48px" }}>
              <ellipse cx="63" cy="48" rx="5.5" ry="5.8" fill="white"/>
              <circle cx="62" cy="48" r="3.5" fill="#1a3a5f"/>
            </g>
            {/* Smile */}
            {isSpeaking
              ? <path d="M 39 70 Q 50 80 61 70" fill="#b45309"/>
              : <path d="M 40 70 Q 50 77 60 70" fill="none" stroke="#b45309" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Alex</p>
      <p className="text-[10px]" style={{ color: ringColor }}>
        {isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}
      </p>
      <style>{`@keyframes blink2{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

function SamPreview({ status }: { status: DemoStatus }) {
  const isSpeaking  = status === "speaking";
  const isListening = status === "listening";
  const isThinking  = status === "thinking";
  const ringColor   = isSpeaking ? "#10b981" : isListening ? "#f97316" : isThinking ? "#a855f7" : "#475569";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && (
          <span className="absolute inset-0 rounded-full opacity-30 animate-ping"
            style={{ border: `2px solid ${ringColor}` }} />
        )}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg, ${ringColor}, #3b82f6, ${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex: 2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="sSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#d1a0a0"/><stop offset="100%" stopColor="#9b6060"/></radialGradient>
              <radialGradient id="sBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0f3326"/><stop offset="100%" stopColor="#041a10"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#sBg)"/>
            <ellipse cx="50" cy="96" rx="38" ry="18" fill="#065f46"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#047857"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#sSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#sSkin)"/>
            {/* Curly hair */}
            <ellipse cx="50" cy="24" rx="28" ry="14" fill="#1a0a00"/>
            {[0,15,30,45,60,75,90].map((a, i) => (
              <circle key={i} cx={50 + 26 * Math.cos((a - 90) * Math.PI / 180)} cy={24 + 12 * Math.sin((a - 90) * Math.PI / 180)} r="4.5" fill="#1a0a00"/>
            ))}
            <g style={{ animation: "blink3 5s ease-in-out infinite", transformOrigin:"37px 48px" }}>
              <ellipse cx="37" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="38" cy="48" r="4" fill="#3d1010"/>
            </g>
            <g style={{ animation: "blink3 5s ease-in-out infinite 0.1s", transformOrigin:"63px 48px" }}>
              <ellipse cx="63" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="62" cy="48" r="4" fill="#3d1010"/>
            </g>
            {isSpeaking
              ? <path d="M 39 70 Q 50 80 61 70" fill="#7f3030"/>
              : <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#7f3030" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Sam</p>
      <p className="text-[10px]" style={{ color: ringColor }}>
        {isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}
      </p>
      <style>{`@keyframes blink3{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

function JordanPreview({ status }: { status: DemoStatus }) {
  const isSpeaking  = status === "speaking";
  const isListening = status === "listening";
  const isThinking  = status === "thinking";
  const ringColor   = isSpeaking ? "#f43f5e" : isListening ? "#38bdf8" : isThinking ? "#facc15" : "#475569";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && (
          <span className="absolute inset-0 rounded-full opacity-30 animate-ping"
            style={{ border: `2px solid ${ringColor}` }} />
        )}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg, ${ringColor}, #f97316, ${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex: 2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="jSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#e8c9a0"/><stop offset="100%" stopColor="#b8834a"/></radialGradient>
              <radialGradient id="jBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1c1520"/><stop offset="100%" stopColor="#080510"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#jBg)"/>
            <ellipse cx="50" cy="96" rx="38" ry="18" fill="#9f1239"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#881337"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#jSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#jSkin)"/>
            {/* Straight dark hair */}
            <rect x="23" y="16" width="54" height="22" rx="8" fill="#111827"/>
            <rect x="23" y="24" width="8" height="32" rx="4" fill="#111827"/>
            <rect x="69" y="24" width="8" height="32" rx="4" fill="#111827"/>
            {/* Bold brows */}
            <path d="M 29 40 Q 38 36 44 38" stroke="#111827" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <path d="M 56 38 Q 62 36 71 40" stroke="#111827" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <g style={{ animation: "blink4 5s ease-in-out infinite", transformOrigin:"37px 48px" }}>
              <ellipse cx="37" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="38" cy="48" r="4.2" fill="#1a0a00"/>
            </g>
            <g style={{ animation: "blink4 5s ease-in-out infinite 0.1s", transformOrigin:"63px 48px" }}>
              <ellipse cx="63" cy="48" rx="6" ry="6.5" fill="white"/>
              <circle cx="62" cy="48" r="4.2" fill="#1a0a00"/>
            </g>
            {/* Beard stubble */}
            <ellipse cx="50" cy="72" rx="16" ry="6" fill="#b8834a" opacity="0.4"/>
            {isSpeaking
              ? <path d="M 39 71 Q 50 80 61 71" fill="#7f3030"/>
              : <path d="M 40 71 Q 50 76 60 71" fill="none" stroke="#9f3030" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Jordan</p>
      <p className="text-[10px]" style={{ color: ringColor }}>
        {isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}
      </p>
      <style>{`@keyframes blink4{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

// ── Avatar registry ───────────────────────────────────────────────────────────

// ── Priya preview ──────────────────────────────────────────────────────────
function PriyaPreview({ status }: { status: DemoStatus }) {
  const isSpeaking = status === "speaking";
  const isListening = status === "listening";
  const isThinking = status === "thinking";
  const ringColor = isSpeaking ? "#ec4899" : isListening ? "#06b6d4" : isThinking ? "#f59e0b" : "#475569";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && <span className="absolute inset-0 rounded-full opacity-30 animate-ping" style={{ border: `2px solid ${ringColor}` }} />}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg,${ringColor},#f97316,${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex:2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="pSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f4a261"/><stop offset="100%" stopColor="#c97040"/></radialGradient>
              <radialGradient id="pBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#1a0a2e"/><stop offset="100%" stopColor="#0a0418"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#pBg)"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#0f766e"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#pSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#pSkin)"/>
            {/* Long hair with centre part */}
            <ellipse cx="50" cy="22" rx="27" ry="13" fill="#1a0505"/>
            <path d="M 50 15 L 50 90" stroke="#1a0505" strokeWidth="4"/>
            <path d="M 23 28 Q 18 55 20 75 Q 22 60 25 45 Z" fill="#1a0505"/>
            <path d="M 77 28 Q 82 55 80 75 Q 78 60 75 45 Z" fill="#1a0505"/>
            <path d="M 23 75 Q 30 85 38 85 L 23 75" fill="#1a0505"/>
            <path d="M 77 75 Q 70 85 62 85 L 77 75" fill="#1a0505"/>
            {/* Bindi */}
            <circle cx="50" cy="38" r="2.5" fill="#ec4899"/>
            {/* Eyes */}
            <g style={{ animation: "blink5 5s ease-in-out infinite", transformOrigin:"37px 49px" }}>
              <ellipse cx="37" cy="49" rx="6" ry="6.5" fill="white"/>
              <circle cx="38" cy="49" r="4.2" fill="#1a0505"/>
            </g>
            <g style={{ animation: "blink5 5s ease-in-out infinite 0.1s", transformOrigin:"63px 49px" }}>
              <ellipse cx="63" cy="49" rx="6" ry="6.5" fill="white"/>
              <circle cx="62" cy="49" r="4.2" fill="#1a0505"/>
            </g>
            {/* Nose dot */}
            <circle cx="50" cy="62" r="1.5" fill="#c97040" opacity="0.5"/>
            {isSpeaking ? <path d="M 39 71 Q 50 80 61 71" fill="#c0392b"/> : <path d="M 40 71 Q 50 77 60 71" fill="none" stroke="#c0392b" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Priya</p>
      <p className="text-[10px]" style={{ color: ringColor }}>{isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}</p>
      <style>{`@keyframes blink5{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

// ── Zara preview ──────────────────────────────────────────────────────────
function ZaraPreview({ status }: { status: DemoStatus }) {
  const isSpeaking = status === "speaking";
  const isListening = status === "listening";
  const isThinking = status === "thinking";
  const ringColor = isSpeaking ? "#38bdf8" : isListening ? "#34d399" : isThinking ? "#7c3aed" : "#475569";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && <span className="absolute inset-0 rounded-full opacity-30 animate-ping" style={{ border: `2px solid ${ringColor}` }} />}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg,${ringColor},#6366f1,${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex:2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="zSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#d4a373"/><stop offset="100%" stopColor="#a07040"/></radialGradient>
              <radialGradient id="zBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0c1a2e"/><stop offset="100%" stopColor="#050e1a"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#zBg)"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#1e3a5f"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#zSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="28" fill="url(#zSkin)"/>
            {/* Hijab — teal */}
            <path d="M 22 38 Q 20 60 22 80 Q 30 86 50 88 Q 70 86 78 80 Q 80 60 78 38 Q 65 18 50 16 Q 35 18 22 38 Z" fill="#0f766e"/>
            <path d="M 22 38 Q 30 25 50 22 Q 70 25 78 38 Q 70 32 50 30 Q 30 32 22 38 Z" fill="#0d9488"/>
            {/* Face showing through */}
            <ellipse cx="50" cy="54" rx="22" ry="24" fill="url(#zSkin)"/>
            <g style={{ animation: "blink6 5s ease-in-out infinite", transformOrigin:"38px 50px" }}>
              <ellipse cx="38" cy="50" rx="5.5" ry="6" fill="white"/>
              <circle cx="39" cy="50" r="3.8" fill="#2d1a00"/>
            </g>
            <g style={{ animation: "blink6 5s ease-in-out infinite 0.1s", transformOrigin:"62px 50px" }}>
              <ellipse cx="62" cy="50" rx="5.5" ry="6" fill="white"/>
              <circle cx="61" cy="50" r="3.8" fill="#2d1a00"/>
            </g>
            {isSpeaking ? <path d="M 40 65 Q 50 74 60 65" fill="#9b3030"/> : <path d="M 41 65 Q 50 71 59 65" fill="none" stroke="#9b3030" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Zara</p>
      <p className="text-[10px]" style={{ color: ringColor }}>{isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}</p>
      <style>{`@keyframes blink6{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

// ── Chen preview ──────────────────────────────────────────────────────────
function ChenPreview({ status }: { status: DemoStatus }) {
  const isSpeaking = status === "speaking";
  const isListening = status === "listening";
  const isThinking = status === "thinking";
  const ringColor = isSpeaking ? "#f97316" : isListening ? "#22d3ee" : isThinking ? "#e879f9" : "#475569";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && <span className="absolute inset-0 rounded-full opacity-30 animate-ping" style={{ border: `2px solid ${ringColor}` }} />}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg,${ringColor},#64748b,${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 3s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#0f172a", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex:2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="cSkin" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#f8d7b0"/><stop offset="100%" stopColor="#d4a070"/></radialGradient>
              <radialGradient id="cBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#111827"/><stop offset="100%" stopColor="#030712"/></radialGradient>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#cBg)"/>
            <path d="M 20 92 Q 30 82 42 87 L 50 93 L 58 87 Q 70 82 80 92 Z" fill="#374151"/>
            <ellipse cx="50" cy="88" rx="10" ry="8" fill="url(#cSkin)"/>
            <ellipse cx="50" cy="52" rx="25" ry="27" fill="url(#cSkin)"/>
            {/* Short neat black hair */}
            <path d="M 24 30 Q 26 16 50 14 Q 74 16 76 30 Q 72 20 50 19 Q 28 20 24 30 Z" fill="#0a0a0a"/>
            <rect x="23" y="24" width="54" height="12" rx="6" fill="#0a0a0a"/>
            {/* Slight eye fold (East Asian feature) */}
            <path d="M 30 46 Q 37 43 44 46" stroke="#8b6a50" strokeWidth="1" fill="none" opacity="0.5"/>
            <path d="M 56 46 Q 63 43 70 46" stroke="#8b6a50" strokeWidth="1" fill="none" opacity="0.5"/>
            <g style={{ animation: "blink7 5s ease-in-out infinite", transformOrigin:"37px 50px" }}>
              <ellipse cx="37" cy="50" rx="6.5" ry="5.8" fill="white"/>
              <circle cx="38" cy="50" r="4" fill="#0a0a0a"/>
              <circle cx="36.8" cy="48.8" r="1.2" fill="white" opacity="0.7"/>
            </g>
            <g style={{ animation: "blink7 5s ease-in-out infinite 0.1s", transformOrigin:"63px 50px" }}>
              <ellipse cx="63" cy="50" rx="6.5" ry="5.8" fill="white"/>
              <circle cx="62" cy="50" r="4" fill="#0a0a0a"/>
              <circle cx="60.8" cy="48.8" r="1.2" fill="white" opacity="0.7"/>
            </g>
            {isSpeaking ? <path d="M 39 70 Q 50 79 61 70" fill="#8b3030"/> : <path d="M 40 70 Q 50 76 60 70" fill="none" stroke="#8b3030" strokeWidth="2.2" strokeLinecap="round"/>}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Chen</p>
      <p className="text-[10px]" style={{ color: ringColor }}>{isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}</p>
      <style>{`@keyframes blink7{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(0.08)}}`}</style>
    </div>
  );
}

// ── Nova preview (AI/Robot style) ─────────────────────────────────────────
function NovaPreview({ status }: { status: DemoStatus }) {
  const isSpeaking = status === "speaking";
  const isListening = status === "listening";
  const isThinking = status === "thinking";
  const ringColor = isSpeaking ? "#a855f7" : isListening ? "#22d3ee" : isThinking ? "#facc15" : "#334155";
  const eyeColor = isSpeaking ? "#c084fc" : isListening ? "#67e8f9" : isThinking ? "#fde047" : "#94a3b8";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: 88, height: 88 }}>
        {status !== "waiting" && <span className="absolute inset-0 rounded-full opacity-30 animate-ping" style={{ border: `2px solid ${ringColor}` }} />}
        <div className="absolute rounded-full" style={{ inset: -2, background: `conic-gradient(from 0deg,${ringColor},#0ea5e9,${ringColor})`, borderRadius:"50%", animation: status !== "waiting" ? "spin 1.5s linear infinite" : "none" }} />
        <div className="absolute rounded-full" style={{ inset: 2, background: "#020617", zIndex:1, borderRadius:"50%" }} />
        <div className="absolute overflow-hidden rounded-full" style={{ inset: 3, zIndex:2 }}>
          <svg viewBox="0 0 100 100" style={{ width:"100%", height:"100%" }}>
            <defs>
              <radialGradient id="nBg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0f172a"/><stop offset="100%" stopColor="#020617"/></radialGradient>
              <radialGradient id="nFace" cx="50%" cy="40%" r="55%"><stop offset="0%" stopColor="#1e293b"/><stop offset="100%" stopColor="#0f172a"/></radialGradient>
              <filter id="nGlow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            <circle cx="50" cy="50" r="50" fill="url(#nBg)"/>
            {/* Circuit lines on background */}
            <path d="M 10 30 L 25 30 L 25 40" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            <path d="M 90 70 L 75 70 L 75 60" stroke="#1e3a5f" strokeWidth="0.8" fill="none"/>
            <circle cx="25" cy="40" r="1.5" fill="#1e3a5f"/>
            <circle cx="75" cy="60" r="1.5" fill="#1e3a5f"/>
            {/* Robot neck / body */}
            <rect x="35" y="88" width="30" height="12" rx="4" fill="#1e293b"/>
            <rect x="20" y="96" width="60" height="8" rx="3" fill="#0f172a"/>
            {/* Antenna */}
            <line x1="50" y1="10" x2="50" y2="22" stroke="#475569" strokeWidth="1.5"/>
            <circle cx="50" cy="9" r="3" fill={ringColor} style={{ filter: `drop-shadow(0 0 4px ${ringColor})` }}/>
            {/* Robot head - hexagonal */}
            <path d="M 28 38 L 22 52 L 28 66 L 72 66 L 78 52 L 72 38 Z" fill="url(#nFace)" stroke="#334155" strokeWidth="1.5"/>
            {/* Panel lines */}
            <path d="M 28 38 L 72 38" stroke="#334155" strokeWidth="0.8"/>
            <path d="M 28 66 L 72 66" stroke="#334155" strokeWidth="0.8"/>
            {/* Glowing eyes (hexagonal robot eyes) */}
            <rect x="32" y="44" width="14" height="10" rx="2" fill="#0f172a" stroke={eyeColor} strokeWidth="1.2"/>
            <rect x="54" y="44" width="14" height="10" rx="2" fill="#0f172a" stroke={eyeColor} strokeWidth="1.2"/>
            <rect x="34" y="46" width="10" height="6" rx="1" fill={eyeColor} opacity="0.9" style={{ filter: `drop-shadow(0 0 3px ${eyeColor})`, animation: isSpeaking ? "novaEye 0.5s ease-in-out infinite alternate" : "none" }}/>
            <rect x="56" y="46" width="10" height="6" rx="1" fill={eyeColor} opacity="0.9" style={{ filter: `drop-shadow(0 0 3px ${eyeColor})` }}/>
            {/* Mouth — LED strip */}
            {isSpeaking ? (
              <rect x="36" y="59" width="28" height="4" rx="2" fill={ringColor} style={{ animation: "novaBar 0.3s ease-in-out infinite alternate", filter: `drop-shadow(0 0 3px ${ringColor})` }}/>
            ) : isListening ? (
              <rect x="36" y="59" width="28" height="4" rx="2" fill={eyeColor} opacity="0.7"/>
            ) : (
              <path d="M 38 61 L 46 59 L 54 61 L 62 59" stroke={eyeColor} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.7"/>
            )}
          </svg>
        </div>
      </div>
      <p className="text-[11px] font-semibold text-white">Nova</p>
      <p className="text-[10px]" style={{ color: ringColor }}>{isSpeaking ? "Speaking…" : isListening ? "Listening…" : isThinking ? "Thinking…" : "Waiting"}</p>
      <style>{`@keyframes novaEye{from{transform:scaleY(1)}to{transform:scaleY(0.2)}} @keyframes novaBar{from{width:28px}to{width:20px;margin-left:4px}}`}</style>
    </div>
  );
}

const AVATARS: AvatarOption[] = [
  {
    id: "maya",
    name: "Maya",
    description: "Friendly & professional — warm skin, gold earrings, blue blazer",
    accent: "ring-blue-500",
    preview: null,
  },
  {
    id: "alex",
    name: "Alex",
    description: "Smart & approachable — auburn hair, glasses, purple shirt",
    accent: "ring-[#4f7ef7]/500",
    preview: null,
  },
  {
    id: "sam",
    name: "Sam",
    description: "Energetic & expressive — curly hair, green blazer",
    accent: "ring-emerald-500",
    preview: null,
  },
  {
    id: "jordan",
    name: "Jordan",
    description: "Confident & bold — dark hair, red blazer, beard",
    accent: "ring-rose-500",
    preview: null,
  },
  {
    id: "priya",
    name: "Priya",
    description: "Elegant & warm — South Asian features, bindi, teal blazer",
    accent: "ring-pink-500",
    preview: null,
  },
  {
    id: "zara",
    name: "Zara",
    description: "Confident & welcoming — hijab, navy blazer",
    accent: "ring-cyan-500",
    preview: null,
  },
  {
    id: "chen",
    name: "Chen",
    description: "Sharp & precise — East Asian features, charcoal suit",
    accent: "ring-orange-500",
    preview: null,
  },
  {
    id: "nova",
    name: "Nova",
    description: "Futuristic AI — robot face, glowing LEDs, circuit board",
    accent: "ring-purple-500",
    preview: null,
  },
];

const DEMO_STATUSES: DemoStatus[] = ["waiting", "speaking", "listening", "thinking"];
const DEMO_LABELS: Record<DemoStatus, string> = {
  waiting: "Idle", speaking: "Speaking", listening: "Listening", thinking: "Thinking",
};

// ── Avatar chooser page ───────────────────────────────────────────────────────

export default function AvatarPage() {
  const [selectedId, setSelectedId] = useState<string>(() =>
    normalizeInterviewerAvatarId(
      typeof window !== "undefined" ? localStorage.getItem("avatarId") : null
    )
  );
  const [demoStatus, setDemoStatus] = useState<DemoStatus>("waiting");
  const [saved, setSaved] = useState(false);

  // Cycle demo status automatically
  useEffect(() => {
    const statuses: DemoStatus[] = ["waiting", "speaking", "listening", "thinking"];
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % statuses.length;
      setDemoStatus(statuses[i]);
    }, 2200);
    return () => clearInterval(t);
  }, []);

  function handleSelect(id: string) {
    const idNorm = normalizeInterviewerAvatarId(id);
    setSelectedId(idNorm);
    localStorage.setItem("avatarId", idNorm);
    window.dispatchEvent(
      new CustomEvent(INTERVIEW_AVATAR_CHANGED_EVENT, { detail: idNorm })
    );
    void fetch("/api/recruiter/avatar", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_id: idNorm }),
    }).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function PreviewFor({ id, status }: { id: string; status: DemoStatus }) {
    switch (id) {
      case "alex":   return <AlexPreview   status={status} />;
      case "sam":    return <SamPreview    status={status} />;
      case "jordan": return <JordanPreview status={status} />;
      case "priya":  return <PriyaPreview  status={status} />;
      case "zara":   return <ZaraPreview   status={status} />;
      case "chen":   return <ChenPreview   status={status} />;
      case "nova":   return <NovaPreview   status={status} />;
      default:       return <MayaPreview   status={status} />;
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* Header */}
      <div className="mb-4">
        <p className="text-xs font-semibold text-violet-600 mb-0.5 uppercase tracking-wide">Avatar</p>
        <h1 className="text-2xl font-bold text-gray-900">AI Interviewer Avatar</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Choose the avatar that will appear to candidates during their interview.
        </p>
      </div>

        {/* Status demo picker */}
        <div className="mb-5 flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 mr-1">Preview state:</span>
          {DEMO_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setDemoStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                demoStatus === s ? "bg-gray-900 text-white" : "bg-white border border-[#e2e4ec] text-gray-600 hover:bg-gray-50"
              }`}
            >
              {DEMO_LABELS[s]}
            </button>
          ))}
        </div>

        {/* Avatar grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          {AVATARS.map((av) => {
            const isSelected = selectedId === av.id;
            return (
              <button
                key={av.id}
                onClick={() => handleSelect(av.id)}
                className={`relative flex flex-col items-center gap-2 rounded-2xl border-2 p-3 transition-all duration-200 ${
                  isSelected
                    ? "border-violet-500 bg-violet-50 shadow-sm"
                    : "border-[#e2e4ec] bg-white hover:border-violet-200 hover:shadow-md"
                }`}
              >
                {/* Selected tick */}
                {isSelected && (
                  <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-violet-500">
                    <Check className="h-2.5 w-2.5 text-white" />
                  </span>
                )}

                {/* Avatar preview */}
                <div className={`rounded-xl p-2 ${isSelected ? "bg-white" : "bg-gray-100"}`}>
                  <PreviewFor id={av.id} status={demoStatus} />
                </div>

                {/* Info */}
                <div className="text-center">
                  <p className={`text-sm font-semibold ${isSelected ? "text-violet-700" : "text-gray-900"}`}>
                    {av.name}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
                    {av.description}
                  </p>
                </div>

                {isSelected && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    <Sparkles className="h-2.5 w-2.5" /> Active
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Save feedback */}
        {saved && (
          <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <Check className="h-4 w-4 text-emerald-500" />
            Avatar saved — candidates will see <strong className="ml-1">{AVATARS.find(a => a.id === selectedId)?.name}</strong> during their interview.
          </div>
        )}
    </div>
  );
}
