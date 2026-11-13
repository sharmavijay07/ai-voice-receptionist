import { handleRetell } from "@/server/webhooks";
import { getDesk, jsonError } from "@/server/singleton";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const desk = await getDesk();
    return Response.json(await handleRetell(desk, body));
  } catch (error) {
    return jsonError(error);
  }
}
