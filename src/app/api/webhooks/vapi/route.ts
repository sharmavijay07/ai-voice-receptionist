import { handleVapi } from "@/server/webhooks";
import { getDesk, jsonError } from "@/server/singleton";

export async function POST(request: Request) {
  try {
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (secret && request.headers.get("x-vapi-secret") !== secret) {
      return Response.json({ error: "Invalid Vapi secret" }, { status: 401 });
    }
    const body = await request.json();
    const desk = await getDesk();
    return Response.json(await handleVapi(desk, body));
  } catch (error) {
    return jsonError(error);
  }
}
