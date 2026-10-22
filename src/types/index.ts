export type JobStatus = 'draft' | 'active' | 'closed';
export type QuestionMode = 'ai_only' | 'custom_only' | 'mixed' | 'resume';
export type QuestionSource = 'ai_generated' | 'custom' | 'resume';
export type SessionStatus = 'pending' | 'in_progress' | 'completed' | 'expired' | 'shortlisted' | 'rejected';
export type QuestionCategory = 'technical' | 'behavioral' | 'situational' | 'culture';
export type ProctoringEventType = 'tab_switch' | 'window_blur' | 'multi_face' | 'no_face' | 'gaze_away' | 'paste_detected';
export type ProctoringEventSeverity = 'low' | 'medium' | 'high';
export type Recommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no';
export type TurnRole = 'interviewer' | 'candidate';

export interface Recruiter {
  id: string;
  better_auth_user_id: string;
  email: string;
  name: string | null;
  company_name: string | null;
  company_intro?: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  recruiter_id: string;
  title: string;
  department: string | null;
  description: string | null;
  company_intro: string | null;
  status: JobStatus;
  question_mode: QuestionMode;
  created_at: string;
  updated_at: string;
}

export interface Question {
  id: string;
  job_id: string;
  text: string;
  category: QuestionCategory;
  difficulty: 1 | 2 | 3;
  expected_hint: string | null;
  order_index: number;
  source: QuestionSource;
  session_id: string | null;
  created_at: string;
}

export interface ScoringRubric {
  id: string;
  job_id: string;
  competency: string;
  weight: number;
  description: string | null;
}

export interface InterviewSession {
  id: string;
  job_id: string;
  token: string;
  candidate_name: string | null;
  candidate_email: string;
  status: SessionStatus;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  video_url: string | null;
  resume_state: ResumeState | null;
  livekit_room: string | null;
  integrity_score: number;
  offtopic_redirect_issued: boolean;
  created_at: string;
}

export interface ResumeState {
  turnIndex: number;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  questionsAsked: string[];
  interviewState: string;
}

export interface TranscriptTurn {
  id: string;
  session_id: string;
  turn_index: number;
  role: TurnRole;
  content: string;
  question_id: string | null;
  timestamp_ms: number | null;
  created_at: string;
}

export interface QuestionScore {
  id: string;
  session_id: string;
  question_id: string | null;
  turn_index: number;
  score: number;
  reasoning: string;
  competencies: Record<string, number> | null;
}

export interface AnalysisResult {
  id: string;
  session_id: string;
  overall_score: number;
  recommendation: Recommendation;
  ai_summary: string;
  competency_scores: Record<string, number>;
  strengths: string[];
  concerns: string[];
  created_at: string;
}

export interface ProctoringEvent {
  id: string;
  session_id: string;
  event_type: ProctoringEventType;
  timestamp_ms: number;
  duration_ms: number | null;
  severity: ProctoringEventSeverity;
  metadata: Record<string, unknown> | null;
}
