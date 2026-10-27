import { notFound } from "next/navigation";
import { pool } from "@/lib/db";
import { format } from "date-fns";
import { CalendarClock, XCircle, Clock, Lock } from "lucide-react";
import ConsentButton from "./ConsentButton";
import CompletedScreen from "./CompletedScreen";
import { estimateInterviewMinutes } from "@/lib/interviewDuration";

interface PageProps {
  params: { token: string };
}

export default async function InterviewLandingPage({ params }: PageProps) {
  const result = await pool.query(
    `SELECT
       s.id,
       s.candidate_name,
       s.status,
       s.expires_at,
       s.started_at,
       s.completed_at,
       j.title AS job_title,
       j.department,
       r.company_name,
       r.name AS recruiter_name,
       (SELECT COUNT(*)::int FROM questions q
         WHERE (q.job_id = s.job_id AND q.session_id IS NULL) OR q.session_id = s.id
       ) AS question_count
     FROM interview_sessions s
     JOIN jobs j ON j.id = s.job_id
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE s.token = $1`,
    [params.token]
  );

  if (!result.rows[0]) notFound();

  const session = result.rows[0];
  const isExpired =
    session.status === "expired" || new Date(session.expires_at) < new Date();
  const isCompleted = session.status === "completed";
  const isShortlisted = session.status === "shortlisted";
  const isRejected = session.status === "rejected";
  // Any terminal state = closed
  const isClosed = isCompleted || isShortlisted || isRejected;
  const companyName = session.company_name || "the company";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-16">
      <div className="w-full max-w-lg">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}>
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </div>
          <span className="text-base font-bold tracking-tight text-gray-900">Screeno</span>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          {isClosed ? (
            <CompletedScreen name={session.candidate_name} />
          ) : isExpired ? (
            <ExpiredState />
          ) : (
            <ActiveState
              candidateName={session.candidate_name}
              jobTitle={session.job_title}
              department={session.department}
              companyName={companyName}
              expiresAt={session.expires_at}
              token={params.token}
              questionCount={session.question_count ?? 0}
            />
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Powered by Screeno &mdash; AI Interview Platform
        </p>
      </div>
    </div>
  );
}

function ActiveState({
  candidateName,
  jobTitle,
  department,
  companyName,
  expiresAt,
  token,
  questionCount,
}: {
  candidateName: string | null;
  jobTitle: string;
  department: string | null;
  companyName: string;
  expiresAt: string;
  token: string;
  questionCount: number;
}) {
  const { low, high } = estimateInterviewMinutes(questionCount);
  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100">
          <Clock className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            Interview Invitation
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Hi {candidateName ?? "there"} — you&apos;re invited!
          </p>
        </div>
      </div>

      <div className="mb-6 rounded-lg bg-gray-50 p-4">
        <p className="text-sm font-medium text-gray-700">{jobTitle}</p>
        {department && (
          <p className="text-sm text-gray-500">{department}</p>
        )}
        <p className="mt-0.5 text-sm text-gray-500">{companyName}</p>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        You&apos;ve been invited to complete an AI-powered video interview for
        this role. It takes approximately <strong>{low}–{high} minutes</strong> and
        can be done from anywhere.
      </p>

      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500">
        <CalendarClock className="h-4 w-4 shrink-0 text-amber-500" />
        <span>
          Link expires{" "}
          <strong className="text-gray-700">
            {format(new Date(expiresAt), "MMMM d, yyyy")}
          </strong>
        </span>
      </div>

      <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        <p className="font-medium text-gray-800">Before you begin</p>
        <ul className="mt-2 list-disc pl-4 space-y-1">
          <li>This interview will be recorded and analysed by AI.</li>
          <li>Your video and responses will be reviewed by the hiring team.</li>
          <li>Ensure you are in a quiet, well-lit place with a working camera and microphone.</li>
        </ul>
      </div>

      <ConsentButton token={token} />
    </>
  );
}

function ExpiredState() {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
        <XCircle className="h-7 w-7 text-red-500" />
      </div>
      <h1 className="text-xl font-bold text-gray-900">Link Expired</h1>
      <p className="mt-2 text-sm text-gray-500">
        This interview link is no longer valid. Please contact the hiring team
        if you believe this is a mistake.
      </p>
      <div className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <Lock className="h-3.5 w-3.5 text-gray-400" />
        <p className="text-xs text-gray-400">
          This interview link has permanently expired and cannot be reused.
        </p>
      </div>
    </div>
  );
}
