import { Resend } from "resend";
import { render } from "@react-email/components";
import { format } from "date-fns";
import { InviteEmail } from "@emails/InviteEmail";

// Sends the interview invitation email for an interview_sessions row. Shared by the manual
// invite route (api/jobs/[id]/invites) and the CV-screening shortlist → invite route.

const resend = new Resend(process.env.RESEND_API_KEY);

export interface InviteEmailResult {
  interviewUrl: string;
  emailSent: boolean;
  emailError?: string;
}

export async function sendInviteEmail(opts: {
  token: string;
  expiresAt: string | Date;
  candidateName: string;
  candidateEmail: string;
  jobTitle: string;
  companyName: string | null;
}): Promise<InviteEmailResult> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const interviewUrl = `${appUrl}/interview/${opts.token}`;
  const expiresAt = format(new Date(opts.expiresAt), "MMMM d, yyyy");
  const companyName = opts.companyName || "the company";

  const html = await render(
    InviteEmail({ candidateName: opts.candidateName, jobTitle: opts.jobTitle, companyName, interviewUrl, expiresAt })
  );

  const { error: emailError } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
    to: opts.candidateEmail,
    subject: `Your interview invitation for ${opts.jobTitle}`,
    html,
  });

  if (emailError) {
    console.error("Resend error:", emailError);
    return { interviewUrl, emailSent: false, emailError: emailError.message };
  }
  return { interviewUrl, emailSent: true };
}
