import { getDesk, jsonError } from "@/server/singleton";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const desk = await getDesk();
    const call = await desk.endCall(id);
    return Response.json({ call });
  } catch (error) {
    return jsonError(error);
  }
}
