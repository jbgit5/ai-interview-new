import {
  Html,
  Head,
  Body,
  Container,
  Heading,
  Text,
  Button,
  Hr,
  Preview,
} from "@react-email/components";

interface InviteEmailProps {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  interviewUrl: string;
  expiresAt: string;
}

export function InviteEmail({
  candidateName,
  jobTitle,
  companyName,
  interviewUrl,
  expiresAt,
}: InviteEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        You&apos;ve been invited to interview for {jobTitle} at {companyName}
      </Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>Interview Invitation</Heading>
          <Text style={paragraph}>Hi {candidateName},</Text>
          <Text style={paragraph}>
            You&apos;ve been invited to interview for the{" "}
            <strong>{jobTitle}</strong> position at{" "}
            <strong>{companyName}</strong>.
          </Text>
          <Text style={paragraph}>
            This is an AI-powered video interview that takes approximately
            15–20 minutes. You can complete it from anywhere at your
            convenience before the link expires.
          </Text>
          <Button href={interviewUrl} style={button}>
            Start Your Interview
          </Button>
          <Hr style={hr} />
          <Text style={footer}>
            This link expires on <strong>{expiresAt}</strong> and can only be
            used once. If you have any questions, reply to this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "40px auto",
  padding: "40px",
  borderRadius: "8px",
  maxWidth: "560px",
  border: "1px solid #e6ebf1",
};

const heading = {
  color: "#1a1a1a",
  fontSize: "24px",
  fontWeight: "600",
  marginBottom: "24px",
};

const paragraph = {
  color: "#444",
  fontSize: "15px",
  lineHeight: "1.6",
  marginBottom: "16px",
};

const button = {
  backgroundColor: "#2563eb",
  borderRadius: "6px",
  color: "#ffffff",
  display: "inline-block",
  fontSize: "15px",
  fontWeight: "600",
  padding: "12px 28px",
  textDecoration: "none",
  margin: "8px 0 24px",
};

const hr = {
  borderColor: "#e6ebf1",
  margin: "24px 0",
};

const footer = {
  color: "#8898aa",
  fontSize: "13px",
  lineHeight: "1.5",
};
