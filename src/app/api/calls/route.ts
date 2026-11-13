import { getDesk, jsonError } from "@/server/singleton";
import type { Channel } from "@/server/types";

const CHANNELS = new Set<Channel>(["simulator", "vapi", "retell", "twilio"]);

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { channel?: Channel; from?: string };
    const channel = body.channel && CHANNELS.has(body.channel) ? body.channel : "simulator";
    const desk = await getDesk();
    const call = await desk.startCall({ channel, from: body.from });
    return Response.json({ call });
  } catch (error) {
    return jsonError(error);
  }
}
