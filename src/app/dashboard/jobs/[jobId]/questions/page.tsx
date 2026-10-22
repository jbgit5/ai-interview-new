import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import QuestionsClient from "./QuestionsClient";
import type { Question, QuestionMode } from "@/types";

export default async function QuestionsPage({
  params,
}: {
  params: { jobId: string };
}) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const ownerCheck = await pool.query(
    `SELECT j.id, j.title, j.question_mode FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.jobId, session.user.id]
  );
  if (!ownerCheck.rows[0]) redirect("/dashboard/jobs");

  const job = ownerCheck.rows[0];

  const result = await pool.query(
    "SELECT * FROM questions WHERE job_id = $1 AND session_id IS NULL ORDER BY order_index, created_at",
    [params.jobId]
  );

  return (
    <QuestionsClient
      jobId={params.jobId}
      jobTitle={job.title}
      questionMode={job.question_mode as QuestionMode}
      initialQuestions={result.rows as Question[]}
    />
  );
}
