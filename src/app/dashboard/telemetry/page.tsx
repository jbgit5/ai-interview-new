import { redirect } from "next/navigation";

/** Legacy path — consolidated UI lives under /dashboard/observability */
export default function TelemetryRedirectPage() {
  redirect("/dashboard/observability");
}
