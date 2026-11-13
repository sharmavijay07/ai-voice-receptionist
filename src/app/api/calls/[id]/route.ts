import { getDesk, jsonError } from "@/server/singleton";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const desk = await getDesk();
    const detail = await desk.callDetail(id);
    if (!detail) return Response.json({ error: "That call isn't on the desk." }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    return jsonError(error);
  }
}
