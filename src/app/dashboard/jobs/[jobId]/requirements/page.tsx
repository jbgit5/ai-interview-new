import RequirementsClient from "@/components/screening/RequirementsClient";

export default function RequirementsPage({ params }: { params: { jobId: string } }) {
  return <RequirementsClient jobId={params.jobId} />;
}
