import { SessionAnalyticsClient } from "@/components/observability/session-analytics-client";

type Props = { params: { sessionId: string } };

export default function ObservabilitySessionPage({ params }: Props) {
  return <SessionAnalyticsClient sessionId={params.sessionId} />;
}
