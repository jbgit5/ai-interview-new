import ScreeningReport from "@/components/screening/ScreeningReport";

export default function ScreeningReportPage({ params }: { params: { jobId: string; screeningId: string } }) {
  return <ScreeningReport jobId={params.jobId} screeningId={params.screeningId} />;
}
