import { redirect } from "next/navigation";

// Old URL — requirements now live on their own job tab.
export default function ScreeningCriteriaPage({ params }: { params: { jobId: string } }) {
  redirect(`/dashboard/jobs/${params.jobId}/requirements`);
}
