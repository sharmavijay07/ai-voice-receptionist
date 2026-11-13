import { getDesk, jsonError } from "@/server/singleton";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json()) as { text?: string };
    const desk = await getDesk();
    const turn = await desk.handleText(id, body.text ?? "");
    return Response.json(turn);
  } catch (error) {
    return jsonError(error);
  }
}
