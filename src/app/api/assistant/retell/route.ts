import { getDesk, jsonError } from "@/server/singleton";

export async function GET() {
  try {
    const desk = await getDesk();
    return Response.json(desk.retellAssistant());
  } catch (error) {
    return jsonError(error);
  }
}
