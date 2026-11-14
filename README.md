# Front desk

An AI voice receptionist for automotive detailing, tint, and service shops. One shop config file drives the greeting, the prices, the hours, and the book. The same desk answers in the browser, on a Vapi or Retell number, or on a Twilio trial line.

The sample shop is **Northline Detail & Tint** in Austin. Maya answers the phone. A second file, `business/bay-tint.yaml`, is a smaller tint shop so you can see what cloning looks like.

## Demo in one command

```bash
npm install
npm run demo
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

No API keys are required. The first run copies `.env.example` to `.env.local`, seeds a sample morning on the book, and serves the dashboard. On the phone page, press **Play sample call**. Maya quotes a full detail, books Alex Rivera, and the appointment shows up on the desk with a logged text and email. Nothing is actually sent.

`npm test` runs the booking, transfer, calendar, Groq, and webhook tests.

## What it covers

| Job requirement | Where it lives |
| --- | --- |
| Answer calls in a natural voice | Browser speech on `/simulator`. Live: Vapi or Retell for a real voice, or Twilio `<Say>` with Polly as the low-cost path. |
| Services, prices, hours | `business/*.yaml`. The model is not allowed to invent these. |
| Name, phone, service request | Captured on the call record and shown on the desk. |
| Check the calendar and book | Mock calendar locally. Google Calendar when `CALENDAR_PROVIDER=google`. |
| Confirmation | SMS and email. Logged in demo mode. Gmail SMTP when `GMAIL_USER` is set, otherwise Resend, otherwise logged. |
| Transfer to a person | Flags the shop number. Twilio dials it. Vapi's `transferCall` tool forwards the live call. Retell cold-transfers with its built-in tool. |
| Log every call | File on the instance, Postgres when `DATABASE_URL` is set, plus a Google Sheet when the sheet id is set. |
| Dashboard | `/` shows calls, upcoming jobs, and the confirmation outbox. |
| Clone per client | A new YAML file and `BUSINESS_CONFIG`. |

## Architecture

```mermaid
flowchart LR
  caller[Caller]
  browser[Browser simulator]
  vapi[Vapi or Retell]
  twilio[Twilio Gather]
  desk[Front desk]
  yaml[Shop YAML]
  groq[Groq gpt-oss-120b]
  builtin[Built-in receptionist]
  cal[Calendar]
  crm[Sheet or local log]
  note[SMS and email]
  n8n[n8n optional]

  caller --> vapi
  caller --> twilio
  browser --> desk
  vapi --> desk
  twilio --> desk
  desk --> yaml
  desk --> groq
  desk --> builtin
  groq --> desk
  desk --> cal
  desk --> crm
  desk --> note
  desk --> n8n
```

Vapi and Retell bring their own speech model and call the desk's tools (`check_availability`, `book_appointment`, `get_shop_info`, `transfer_call`). The browser and the Twilio path use this server's language model.

**Groq is the default language model**: `openai/gpt-oss-120b` on the OpenAI-compatible API at `https://api.groq.com/openai/v1`. Set `GROQ_API_KEY` and the next turn goes to Groq. The server sends at most two completions per caller turn and sets `reasoning_effort=low`, because the free tier's token budget is small.

If the key is empty, or Groq returns an error or a 429, the built-in receptionist answers that turn. It uses the same calendar, the same prices, and the same booking rules, so a missing key does not stop the demo and a rate limit does not drop a live call. The built-in path is also what the tests exercise.

Gemini is optional. Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY`. Set `LLM_PROVIDER=none` to force the built-in receptionist even when a Groq key is present.

`LLM_MODE=tools` (the default) lets the model call the shop tools. `LLM_MODE=rephrase` lets the built-in policy decide and asks Groq only to speak the line. Prices and times are kept as written.

## Layout

```
business/northline.yaml     sample detailing and tint shop
business/bay-tint.yaml      second shop, to copy from
src/server/dialogue.ts      built-in receptionist
src/server/llm.ts           Groq and optional Gemini
src/server/desk.ts          bookings, confirmations, call log
src/server/providers.ts     mock, Google Calendar, Sheets, Gmail, Twilio, Resend
src/app/api/webhooks/       Vapi, Retell, Twilio
src/app/simulator/          browser phone
n8n/booking-webhook.json    optional import
```

## Run it locally

1. Install Node 22 and run `npm install`.
2. `npm run demo`.
3. Open the desk. The left rail shows which providers are mock and which are live.
4. Open the phone. Type, use the mic (Chrome or Edge), or play the sample call.
5. `npm test` before you change the booking rules.

The dev server listens on port **43123**. `npm start` binds to `0.0.0.0` and `$PORT` (43123 when `PORT` is unset), which is what Render's free web service expects.

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sharmavijay07/ai-voice-receptionist)

The blueprint is `render.yaml`: a free Node web service. Build and start:

```bash
npm install --include=dev --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=460 npm run build
NODE_OPTIONS=--max-old-space-size=384 npm run start
```

`npm start` runs `node scripts/start.mjs`, which listens on `0.0.0.0:$PORT`. The heap caps stay inside the free plan's 512 MB.

The blueprint leaves every secret as `sync: false`, so the public URL is a working demo until you paste them. The free instance sleeps after inactivity. The first visit wakes it. The call log stays on the instance disk until `DATABASE_URL` is set.

The live checklist below is the list of values Don pastes in the Render dashboard. `VAPI_MODEL_PROVIDER` is already `vapi`, so the phone line does not need a Groq key saved inside Vapi.

## Go live with free tools

Do this in accounts Don controls. On Render, open the service **ai-voice-receptionist** → Environment, and paste each value. Locally, put the same keys in `.env.local`. Nothing here requires a paid plan.

The public origin is `https://ai-voice-receptionist-mczp.onrender.com`.

| Env var | Where Don gets it | What it does |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | The Render URL above. Render also sets `RENDER_EXTERNAL_URL` on the instance, which the app uses if this is empty. Set this yourself when you run `npm run vapi:sync` from a laptop. | Tool and webhook URLs. |
| `VAPI_API_KEY` | [dashboard.vapi.ai](https://dashboard.vapi.ai) → API Keys → copy the **private** key. | `npm run vapi:sync` attaches the tools. |
| `VAPI_ASSISTANT_ID` | Vapi → Assistants → open the assistant already on the free number. The id is in the URL. | Which assistant the sync updates. Leave it empty the first time to create one, then save the id the script prints. |
| `TRANSFER_NUMBER` | Don's mobile, E.164, for example `+15125550190`. | Vapi `transferCall` forwards here. Retell cold-transfers here. Twilio `<Dial>` uses it too. If empty, the number in `business/northline.yaml` is used. |
| `GMAIL_USER` | The Gmail address that should send confirmations, for example `don@gmail.com`. | SMTP login and the From address. |
| `GMAIL_APP_PASSWORD` | Google Account → Security → turn on **2-Step Verification** → **App passwords** → Mail → generate. Paste the 16-character password (spaces are fine). This is not the normal Gmail password. | SMTP password for `smtp.gmail.com:465`. |
| `SHOP_OWNER_EMAIL` | Don's inbox. | Booking alert. The customer gets a copy only when they gave an email on the call. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The JSON key file from the Google steps below. Paste the whole file as one value. | Signs in to Calendar and Sheets. No OAuth consent screen. |
| `GOOGLE_CALENDAR_ID` | Google Calendar → the shop calendar → Settings → Integrate calendar → Calendar ID. | Where appointments are written. Sharing this calendar with the service account turns Google Calendar on. |
| `GOOGLE_SHEETS_ID` | The id in the spreadsheet URL: `docs.google.com/spreadsheets/d/<this part>/edit`. | Call rows. Sharing the sheet with the service account turns the sheet on. The desk creates a `Calls` tab if it is missing. |
| `DATABASE_URL` | [Neon](https://neon.tech) or [Supabase](https://supabase.com) free Postgres. Copy the pooled connection string (`postgres://...`). | Call log that survives a free-instance restart. If this is empty, the log stays in `data/store.json` on the instance disk. |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API Keys. Free, no card. | Optional. The browser and Twilio path use Groq `openai/gpt-oss-120b`. Leave it empty and the built-in receptionist answers. Vapi does not read this key. |

`VAPI_MODEL_PROVIDER` is already `vapi` in `render.yaml`. That is Vapi's own hosted model, so you do not add a Groq key under Vapi → Provider Keys. To use Groq on the Vapi call instead, set `VAPI_MODEL_PROVIDER=groq` and `VAPI_MODEL=openai/gpt-oss-120b`, then add your Groq key in Vapi's provider settings. The browser path keeps using `GROQ_API_KEY` either way.

Gmail is preferred over Resend whenever `GMAIL_USER` and `GMAIL_APP_PASSWORD` are both set. If neither Gmail nor Resend is configured, email is only logged on the desk (demo mode). A failed send does not undo the booking.

Google Calendar and Sheets turn on when the service account JSON and the matching id are set, even if `CALENDAR_PROVIDER` or `CRM_PROVIDER` still say mock. Set `CALENDAR_PROVIDER=off` or `CRM_PROVIDER=off` to force the local book. `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` still work if you would rather paste those two fields than the whole JSON.

When Gmail, Google, or `DATABASE_URL` is set, the sample morning is not seeded.

### Attach the Vapi tools

The assistant on the free Vapi number should already use server URL `https://ai-voice-receptionist-mczp.onrender.com/api/webhooks/vapi`. It does not forward or book until the tools are attached.

From a machine that has the env vars (or the Render shell):

```bash
PUBLIC_BASE_URL=https://ai-voice-receptionist-mczp.onrender.com \
VAPI_API_KEY=your-private-key \
VAPI_ASSISTANT_ID=your-assistant-id \
TRANSFER_NUMBER=+1yournumber \
npm run vapi:sync
```

That PATCHes the assistant. The tools are `check_availability`, `book_appointment`, `get_shop_info`, `transfer_call`, and `end_call`. The first three POST to the server URL. `transfer_call` is Vapi's `transferCall` tool with `TRANSFER_NUMBER` as a blind-transfer destination, so the call forwards even if the free instance is asleep. `end_call` hangs up. `GET /api/assistant/vapi` returns the same payload if you would rather paste it.

Optional: `VAPI_WEBHOOK_SECRET`. Vapi sends it as `x-vapi-secret`.

### Retell, if you use it

Cold transfer is part of the Retell call. There is no extra tool fee. `GET /api/assistant/retell` returns a Retell LLM payload whose `transfer_call` tool dials `TRANSFER_NUMBER` and whose custom tools POST to `/api/webhooks/retell`. Paste `general_tools` onto the Retell LLM. Availability results still include `label | ISO` rows to pass back to `book_appointment`.

### Google Calendar and the call sheet

1. Open [Google Cloud Console](https://console.cloud.google.com) and create a project. The free tier is enough.
2. APIs & Services → Library. Enable **Google Calendar API** and **Google Sheets API**.
3. APIs & Services → Credentials → Create credentials → **Service account**. Name it `front-desk`. Open the account → Keys → Add key → JSON. Download the file.
4. In Google Calendar, create a calendar for the shop (or use an existing one). Settings for that calendar → Share with specific people → add the service account email (`...@...iam.gserviceaccount.com`) as **Make changes to events**. Copy the Calendar ID.
5. Create a spreadsheet. Share it with the same service account email as **Editor**. Copy the spreadsheet id from the URL. You do not have to add the `Calls` tab yourself. The first booking creates it and writes the header row: Timestamp, Call id, From, Customer, Phone, Service, Status, Appointment, Summary, Channel.
6. Paste `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole file), `GOOGLE_CALENDAR_ID`, and `GOOGLE_SHEETS_ID` into Render.

The desk signs its own JWT. It does not invite the customer to the event, because a service account cannot do that without domain-wide delegation. The email and phone go in the event description.

### Gmail confirmations

1. Sign in to the Google account that should send the mail.
2. Turn on 2-Step Verification if it is off: [myaccount.google.com/security](https://myaccount.google.com/security).
3. Search the account page for **App passwords**. Choose Mail and your device, then generate.
4. Set `GMAIL_USER` to that Gmail address, `GMAIL_APP_PASSWORD` to the 16 characters, and `SHOP_OWNER_EMAIL` to the inbox that should see every booking.
5. Redeploy. The next booking sends through `smtp.gmail.com` port 465. The customer is emailed only when the call collected an address. Don always gets the shop alert.

### Call log that survives sleep

1. Create a free project at [Neon](https://neon.tech) or [Supabase](https://supabase.com).
2. Copy the Postgres connection string. Prefer the pooler string. It looks like `postgres://user:password@host/dbname?sslmode=require`.
3. Set `DATABASE_URL` on Render and redeploy.

The desk keeps one JSON document in a `desk_store` table. If the database cannot be reached, the desk keeps serving and writes the file log, and the dashboard says so.

### Still optional

**Groq for the browser and Twilio path.** Set `GROQ_API_KEY`. Leave `GROQ_MODEL=openai/gpt-oss-120b`. The call ticket shows that model when Groq answered, and a fallback note when it did not.

**Twilio trial.** Buy or claim a number and set the voice webhook to `POST https://ai-voice-receptionist-mczp.onrender.com/api/webhooks/twilio`. A transfer becomes `<Dial>` to `TRANSFER_NUMBER`. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` before texts are actually sent. Trial accounts can only call verified numbers.

**Resend**, only if you are not using Gmail:

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=
NOTIFY_FROM_EMAIL=maya@the-shop.com
```

**n8n.**

Import `n8n/booking-webhook.json`, activate it, and set `N8N_WEBHOOK_URL`. The desk already writes the calendar, the sheet, and the confirmation. Use n8n when the shop wants a side effect this app does not do. `N8N_WEBHOOK_SECRET` is sent as `x-webhook-secret`.

## Customise a shop

1. Copy `business/northline.yaml` to `business/the-new-shop.yaml`.
2. Change the name, Maya's name, the greeting, the address, the transfer number, the hours, the services, and the FAQs. Prices in the file are the only prices the receptionist will quote.
3. `duration_minutes` is the calendar block. `deposit: true` adds the payment policy to the confirmation.
4. Set `BUSINESS_CONFIG=business/the-new-shop.yaml`.
5. Save. The next call rereads the file. You do not need a second codebase.

Hours are the shop's local clock in `timezone`. Sunday is `null` when the shop is closed. `lead_time_hours` is the shortest notice Maya will book. `buffer_minutes` is the gap she leaves between jobs.

## Tests

```bash
npm test
npm run typecheck
```

The suite freezes the clock at Friday 13 November 2026, 3:00 PM in Chicago, and checks prices, Sunday, the two-hour notice, double booking, transfer, cancellation, the Groq request shape, Groq failure fallback, and the Vapi, Retell, and Twilio webhooks. It does not call Groq.

## What it costs

Figures below are for a small shop: about 200 inbound calls a month, three minutes each (600 minutes), and about 80 confirmation texts. Check the vendor pages before you quote a client. They move.

### Demo and development

$0. Browser voice, mock calendar, local log, logged texts and emails.

### Groq free tier

Default model `openai/gpt-oss-120b`, from Groq's free-plan rate limits (their docs describe the table as a summary; the Limits page in the account is the authority):

| Limit | Free plan for openai/gpt-oss-120b |
| --- | --- |
| Requests per minute | 30 |
| Requests per day | 1,000 |
| Tokens per minute | 8,000 |
| Tokens per day | 200,000 |

Limits are per organization, not per key. Input and output tokens both count. A 429 means that limit is used up. Per-minute limits recover quickly. The daily request and token caps do not, until the window rolls.

The 8,000 tokens per minute cap is the one that bites. A tools turn sends the shop prompt, a short history, and the tool definitions, then sometimes a second completion. Two completions are the maximum per caller turn, and `reasoning_effort` defaults to `low`, so one call usually fits. Two calls at the same time can trip the minute cap. When that happens the built-in receptionist finishes the turn and the ticket says so.

200,000 tokens a day is roughly a hundred full tool turns if each one is heavy, and more when some turns are short. A 15-call day is comfortable. A slammed Saturday can brush the cap. That is the point where you upgrade Groq's Developer plan or leave the built-in receptionist on for the overflow. The Developer plan's published base for this model is much higher (on the order of 1,000 requests per minute and 250,000 tokens per minute). Confirm it on the pricing page before you promise it.

Signing up for the free plan does not require a card. You pay when you move to Developer.

### A live shop line

| Piece | Rough monthly cost at 600 minutes |
| --- | --- |
| Groq `openai/gpt-oss-120b` | $0 inside the free tier above |
| Vapi hosting | about $0.05/min, about $30, plus a few dollars of speech-to-text |
| Vapi voice (their own voice, not ElevenLabs) | about $0.01 to $0.02/min, about $6 to $12 |
| Vapi phone number | 1 US number included on the usage plan. About $5 of credit to start |
| Google Calendar and Sheets | $0 |
| Gmail SMTP | $0 with an app password. Resend's free tier is the fallback (3,000 emails/month) |
| Neon or Supabase Postgres | $0 on the free tier, so the call log survives a restart |
| Twilio SMS | about $0.008 per message, under $1, plus a trial credit |
| n8n on a machine you already have | $0 |

**About $45 to $70 a month** with Vapi, Groq's free tier, and Google. ElevenLabs on top of Vapi adds roughly $0.02 a minute.

Retell is in the same band: voice infra about $0.055/min plus a platform voice around $0.015/min and a cheap model, US telephony about $0.015/min if you use theirs, number about $2/month, about $10 of starting credit.

The Twilio Gather path skips Vapi. Voice is about $0.0085/min inbound plus $1.15 for the number, and Polly is included in the `<Say>`. Call it **about $10 to $20 a month** plus Groq at $0, with a less natural voice. Use it for a trial, then move the same tools to Vapi when the shop wants the voice to sound like a person.

## Operating notes

- The desk log is `data/store.json`, unless `DATABASE_URL` is set, in which case Postgres is the copy that survives a restart. **Reset demo** on the dashboard restores the sample morning when the providers are still in demo mode.
- Sample rows are badged so a live call is obvious next to them.
- A booking is real only after the calendar accepts it. If Groq says someone is booked and no event was created, that turn is thrown out and the built-in receptionist handles it.
- Transfer in the browser records the number and shows it. Twilio dials it. Vapi's `transferCall` tool forwards the live call to `TRANSFER_NUMBER`. Retell's `transfer_call` tool does the same with a cold transfer.
- `PUBLIC_BASE_URL` must be the public https origin before Twilio or Vapi can reach the webhooks.
