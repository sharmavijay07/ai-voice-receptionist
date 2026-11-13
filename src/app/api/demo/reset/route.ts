import { getDesk, jsonError } from "@/server/singleton";

export async function POST() {
  try {
    const desk = await getDesk();
    await desk.reset();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
