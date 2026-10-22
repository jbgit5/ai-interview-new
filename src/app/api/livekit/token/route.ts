import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function POST(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "LiveKit not configured" }, { status: 500 });
  }

  const body = await request.json();
  const { room, participant_name } = body;

  if (!room || !participant_name) {
    return NextResponse.json(
      { error: "room and participant_name are required" },
      { status: 400 }
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participant_name,
    ttl: "2h",
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();

  return NextResponse.json({ token });
}
