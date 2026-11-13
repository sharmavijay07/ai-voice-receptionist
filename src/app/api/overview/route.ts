import { getDesk, jsonError } from "@/server/singleton";

export async function GET() {
  try {
    const desk = await getDesk();
    return Response.json(await desk.overview());
  } catch (error) {
    return jsonError(error);
  }
}
