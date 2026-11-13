import { getDesk, jsonError } from "@/server/singleton";
import { handleTwilio, twilioAuthorized } from "@/server/webhooks";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) params[key] = String(value);
    const base = process.env.PUBLIC_BASE_URL || new URL(request.url).origin;
    const url = `${base.replace(/\/$/, "")}/api/webhooks/twilio`;
    if (!twilioAuthorized({ url, params, signature: request.headers.get("x-twilio-signature"), authToken: process.env.TWILIO_AUTH_TOKEN })) {
      return new Response("Invalid Twilio signature", { status: 401 });
    }
    const desk = await getDesk();
    const xml = await handleTwilio(desk, params, base, process.env.TWILIO_SAY_VOICE || "Polly.Joanna-Neural");
    return new Response(xml, { headers: { "Content-Type": "text/xml" } });
  } catch (error) {
    return jsonError(error);
  }
}
