import { getDesk, jsonError } from "@/server/singleton";

export async function GET() {
  try {
    const desk = await getDesk();
    const business = desk.business();
    const providers = desk.providerStatus();
    return Response.json({
      ok: true,
      business: business.name,
      assistant: business.assistant_name,
      demo: providers.calendar.mode === "mock",
      providers,
    });
  } catch (error) {
    return jsonError(error);
  }
}
