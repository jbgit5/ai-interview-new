"use client";

import { CheckCircle2, Lock } from "lucide-react";

export default function CompletedScreen({ name }: { name: string | null }) {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
        <CheckCircle2 className="h-7 w-7 text-emerald-600" />
      </div>
      <h1 className="text-xl font-bold text-gray-900">Interview Completed</h1>
      <p className="mt-2 text-sm text-gray-500">
        {name ? `Thanks, ${name}!` : "Thank you!"} Your responses have been
        recorded and the hiring team will be in touch.
      </p>

      <div className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <Lock className="h-3.5 w-3.5 text-gray-400" />
        <p className="text-xs text-gray-400">
          This interview link has been permanently closed and cannot be reused.
        </p>
      </div>
    </div>
  );
}
