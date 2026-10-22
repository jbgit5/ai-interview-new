"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

export default function ConsentButton({ token }: { token: string }) {
  const router = useRouter();
  const [consented, setConsented] = useState(false);

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">
          I consent to this interview being recorded and analysed by AI. I
          understand my responses will be reviewed by the hiring team.
        </span>
      </label>

      <button
        disabled={!consented}
        onClick={() => router.push(`/interview/${token}/check`)}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Begin Interview
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
