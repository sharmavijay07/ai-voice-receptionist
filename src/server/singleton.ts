import { FrontDesk } from "./desk";

const globalDesk = globalThis as unknown as { __frontDesk?: Promise<FrontDesk> };

export function getDesk(): Promise<FrontDesk> {
  if (!globalDesk.__frontDesk) {
    const env = process.env;
    const liveCalendar = (env.CALENDAR_PROVIDER ?? "mock") === "google";
    const liveSms = (env.SMS_PROVIDER ?? "mock") === "twilio";
    const liveEmail = (env.EMAIL_PROVIDER ?? "mock") === "resend";
    globalDesk.__frontDesk = FrontDesk.create({
      env,
      storePath: env.STORE_PATH || "data/store.json",
      seed: env.DEMO_SEED !== "false" && !liveCalendar && !liveSms && !liveEmail,
    });
  }
  return globalDesk.__frontDesk;
}

export function jsonError(error: unknown): Response {
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "not_found") {
    return Response.json({ error: error instanceof Error ? error.message : "Not found" }, { status: 404 });
  }
  if (error instanceof Error && /config/i.test(error.message)) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  console.error(error);
  return Response.json({ error: error instanceof Error ? error.message : "The desk hit an unexpected error." }, { status: 500 });
}
