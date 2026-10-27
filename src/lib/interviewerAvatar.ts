/** AI interviewer avatar — must stay in sync with `MayaAvatar` + dashboard avatar picker. */
export const INTERVIEWER_AVATAR_IDS = [
  "maya",
  "alex",
  "sam",
  "jordan",
  "priya",
  "zara",
  "chen",
  "nova",
  /** Real-person photo avatar. Lip-synced video via Simli when enabled + GPT-Live; static photo otherwise. */
  "real",
] as const;

export type InterviewerAvatarId = (typeof INTERVIEWER_AVATAR_IDS)[number];

export function normalizeInterviewerAvatarId(
  raw: string | null | undefined
): InterviewerAvatarId {
  const s = String(raw ?? "maya").toLowerCase().trim();
  return (INTERVIEWER_AVATAR_IDS as readonly string[]).includes(s)
    ? (s as InterviewerAvatarId)
    : "maya";
}

export const INTERVIEW_AVATAR_CHANGED_EVENT = "screeno:interviewerAvatarChanged";
