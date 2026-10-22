"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Download, Loader2 } from "lucide-react";

interface Props {
  sessionId: string;
  currentStatus: string;
  candidateName: string;
}

export default function ReportActions({ sessionId, currentStatus, candidateName }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [loading, setLoading] = useState<"shortlist" | "reject" | "pdf" | null>(null);

  async function updateStatus(newStatus: "shortlisted" | "rejected") {
    setLoading(newStatus === "shortlisted" ? "shortlist" : "reject");
    try {
      const res = await fetch(`/api/analysis/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        setStatus(newStatus);
        router.refresh();
      }
    } finally {
      setLoading(null);
    }
  }

  async function downloadPDF() {
    setLoading("pdf");
    try {
      const res = await fetch(`/api/reports/${sessionId}/pdf`);
      if (!res.ok) throw new Error("PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      a.href = url;
      a.download = `report-${safeName}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={downloadPDF}
        disabled={loading !== null}
        className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {loading === "pdf" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Export PDF
      </button>

      {status !== "shortlisted" && (
        <button
          onClick={() => updateStatus("shortlisted")}
          disabled={loading !== null}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {loading === "shortlist" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          Shortlist
        </button>
      )}

      {status !== "rejected" && (
        <button
          onClick={() => updateStatus("rejected")}
          disabled={loading !== null}
          className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {loading === "reject" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Reject
        </button>
      )}

      {(status === "shortlisted" || status === "rejected") && (
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${
            status === "shortlisted"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-red-100 text-red-600"
          }`}
        >
          {status === "shortlisted" ? "✓ Shortlisted" : "✗ Rejected"}
        </span>
      )}
    </div>
  );
}
