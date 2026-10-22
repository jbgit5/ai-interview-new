"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Send, Copy, Check, Loader2, Mail, FileSearch, Eye, X, Sparkles } from "lucide-react";
import { format } from "date-fns";

type InviteStatus = "pending" | "in_progress" | "completed" | "expired" | "shortlisted" | "rejected";

interface Invite {
  id: string;
  candidate_name: string | null;
  candidate_email: string;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  token: string;
}

interface CandidateQuestion {
  id: string;
  text: string;
  category: string;
  difficulty: number;
  expected_hint: string | null;
  source: string;
}

const CATEGORY_STYLES: Record<string, string> = {
  technical:   "bg-blue-100 text-blue-700",
  behavioral:  "bg-purple-100 text-purple-700",
  situational: "bg-amber-100 text-amber-700",
  culture:     "bg-green-100 text-green-700",
};

const DIFFICULTY_STARS = (n: number) => "★".repeat(n) + "☆".repeat(3 - n);

const STATUS_STYLES: Record<InviteStatus, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  expired: "bg-gray-100 text-gray-500",
  shortlisted: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-600",
};

const STATUS_LABELS: Record<InviteStatus, string> = {
  pending: "Invited",
  in_progress: "In Progress",
  completed: "Completed",
  expired: "Expired",
  shortlisted: "Shortlisted",
  rejected: "Rejected",
};

export default function InvitePage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;

  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [jobMode, setJobMode] = useState<string | null>(null);
  const [resumeFile, setResumeFile] = useState<File | null>(null);

  // Candidate questions preview modal
  const [previewInvite, setPreviewInvite] = useState<Invite | null>(null);
  const [previewQuestions, setPreviewQuestions] = useState<CandidateQuestion[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadInvites = useCallback(async () => {
    setLoadingInvites(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/invites`);
      if (res.ok) {
        const data = await res.json();
        setInvites(data);
      }
    } finally {
      setLoadingInvites(false);
    }
  }, [jobId]);

  useEffect(() => {
    loadInvites();
    // Load job mode to check if CV upload is needed
    fetch(`/api/jobs/${jobId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setJobMode(data.question_mode ?? null); })
      .catch(() => {});
  }, [loadInvites, jobId]);

  async function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSendError(null);
    setSendSuccess(null);
    setSending(true);

    const formData = new FormData(e.currentTarget);
    const candidateName = formData.get("candidate_name") as string;
    const candidateEmail = formData.get("candidate_email") as string;

    let res: Response;
    if (resumeFile) {
      // Multipart: include CV file
      const fd = new FormData();
      fd.append("candidate_name", candidateName);
      fd.append("candidate_email", candidateEmail);
      fd.append("resume", resumeFile);
      res = await fetch(`/api/jobs/${jobId}/invites`, { method: "POST", body: fd });
    } else {
      res = await fetch(`/api/jobs/${jobId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_name: candidateName, candidate_email: candidateEmail }),
      });
    }
    try {
      const data = await res.json();

      if (res.status === 201) {
        setSendSuccess(`Invite sent to ${candidateEmail}`);
        (e.target as HTMLFormElement).reset();
        setResumeFile(null);
        await loadInvites();
      } else if (res.status === 207) {
        // Email failed, but session was created — show link
        setSendSuccess(
          `Invite created (email failed — copy the link manually)`
        );
        (e.target as HTMLFormElement).reset();
        setResumeFile(null);
        await loadInvites();
      } else {
        setSendError(data.error ?? "Failed to send invite");
      }
    } catch {
      setSendError("Network error — please try again");
    } finally {
      setSending(false);
    }
  }

  async function openPreview(invite: Invite) {
    setPreviewInvite(invite);
    setPreviewQuestions([]);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/invites/${invite.id}/questions`);
      if (res.ok) setPreviewQuestions(await res.json());
    } finally {
      setPreviewLoading(false);
    }
  }

  function copyLink(token: string) {
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
    navigator.clipboard.writeText(`${appUrl}/interview/${token}`);
    setCopiedId(token);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="px-6 py-6">
      {/* Send invite form */}
      <div className="mb-4 sc-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            Send Interview Invite
          </h2>
        </div>

        <form onSubmit={handleSend} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-600">
                Candidate Name <span className="text-red-500">*</span>
              </label>
              <input
                name="candidate_name"
                type="text"
                required
                placeholder="Jane Smith"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-600">
                Candidate Email <span className="text-red-500">*</span>
              </label>
              <input
                name="candidate_email"
                type="email"
                required
                placeholder="jane@example.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* CV upload — only for resume mode */}
          {jobMode === "resume" && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-emerald-800">
                <FileSearch className="h-4 w-4" />
                Candidate CV / Resume <span className="text-red-500">*</span>
              </label>
              <p className="mb-2 text-xs text-emerald-600">
                AI will generate personalised questions from this CV before the interview starts.
              </p>
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-emerald-700"
              />
              {resumeFile && <p className="mt-1 text-xs text-emerald-700">Selected: {resumeFile.name}</p>}
            </div>
          )}

          {sendError && (
            <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-600">
              {sendError}
            </p>
          )}
          {sendSuccess && (
            <p className="rounded-md bg-green-50 px-4 py-2 text-sm text-green-700">
              {sendSuccess}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={sending}
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {sending ? "Sending…" : "Send Invite"}
            </button>
          </div>
        </form>
      </div>

      {/* Sent invites */}
      <div>
        <h3 className="mb-4 text-sm font-semibold text-gray-600">
          Sent Invites
        </h3>

        {loadingInvites ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
          </div>
        ) : invites.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
            <p className="text-sm text-gray-500">No invites sent yet.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[#e2e4ec] bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e2e4ec] bg-gray-50 text-left text-xs font-medium text-gray-500">
                  <th className="px-4 py-3">Candidate</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sent</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Questions</th>
                  <th className="px-4 py-3">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invites.map((invite) => (
                  <tr key={invite.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">
                        {invite.candidate_name ?? "—"}
                      </p>
                      <p className="text-xs text-gray-500">
                        {invite.candidate_email}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[invite.status]}`}
                      >
                        {STATUS_LABELS[invite.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {format(new Date(invite.created_at), "MMM d, yyyy")}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {format(new Date(invite.expires_at), "MMM d, yyyy")}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => openPreview(invite)}
                        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                        title="View AI-generated questions for this candidate"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {["completed", "shortlisted", "rejected", "expired"].includes(invite.status) ? (
                        <span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-gray-400 cursor-default select-none">
                          <X className="h-3.5 w-3.5" />
                          Link Expired
                        </span>
                      ) : (
                        <button
                          onClick={() => copyLink(invite.token)}
                          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                          title="Copy interview link"
                        >
                          {copiedId === invite.token ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-green-600" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" />
                              Copy link
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Questions Preview Modal ─────────────────────────────────────── */}
      {previewInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl flex flex-col max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#e2e4ec] px-6 py-4 shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <FileSearch className="h-5 w-5 text-emerald-600" />
                  <h2 className="text-base font-semibold text-gray-900">Interview Questions</h2>
                </div>
                <p className="mt-0.5 text-sm text-gray-500">
                  {previewInvite.candidate_name ?? previewInvite.candidate_email}
                </p>
              </div>
              <button onClick={() => setPreviewInvite(null)}>
                <X className="h-5 w-5 text-gray-500 hover:text-gray-600" />
              </button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto p-6">
              {previewLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
                </div>
              ) : previewQuestions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#e2e4ec] p-8 text-center">
                  <p className="text-sm font-medium text-gray-600">No questions found</p>
                  <p className="mt-1 text-xs text-gray-500">
                    No questions have been added to this job yet. Go to the Questions tab to add or generate questions.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="mb-4 text-xs text-gray-500">
                    {previewQuestions.length} question{previewQuestions.length !== 1 ? "s" : ""} — all questions this candidate will be asked
                  </p>
                  {previewQuestions.map((q, idx) => (
                    <div key={q.id} className="rounded-lg border border-[#e2e4ec] bg-gray-50 p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white border border-[#e2e4ec] text-xs font-medium text-gray-500">
                          {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-900">{q.text}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${CATEGORY_STYLES[q.category] ?? "bg-gray-100 text-gray-600"}`}>
                              {q.category}
                            </span>
                            <span className="text-xs text-amber-500">{DIFFICULTY_STARS(q.difficulty)}</span>
                            {q.source === "resume" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
                                <Sparkles className="h-3 w-3" />Resume AI
                              </span>
                            ) : q.source === "ai" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                                <Sparkles className="h-3 w-3" />AI Generated
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                                Custom
                              </span>
                            )}
                          </div>
                          {q.expected_hint && (
                            <p className="mt-1.5 text-xs text-gray-500">💡 {q.expected_hint}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-[#e2e4ec] px-6 py-4 shrink-0">
              <button onClick={() => setPreviewInvite(null)}
                className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
