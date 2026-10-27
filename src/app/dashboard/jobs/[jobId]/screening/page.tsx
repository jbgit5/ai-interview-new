import ScreeningClient from "@/components/screening/ScreeningClient";

// Access is enforced by the job layout (ownership check) and again by every API route.
export default function ScreeningPage({ params }: { params: { jobId: string } }) {
  return <ScreeningClient jobId={params.jobId} />;
}
