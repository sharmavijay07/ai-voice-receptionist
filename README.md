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
| Confirmation | SMS and email. Logged in demo mode. Twilio and Resend when configured. |
| Transfer to a person | Flags the shop number. Twilio dials it. Vapi and Retell get a transfer tool result. |
| Log every call | Local desk log, plus a Google Sheet when `CRM_PROVIDER=google`. |
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
src/server/providers.ts     mock, Google Calendar, Sheets, Twilio, Resend
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

On the Render dashboard, the only value you type in is **GROQ_API_KEY** (`sync: false` in the blueprint). The model is `openai/gpt-oss-120b` at `https://api.groq.com/openai/v1`. Calendar, Sheets, Twilio, Resend, Vapi, and Retell stay in demo mode until their keys exist, so the public URL is a working desk with only the Groq key set. The call log lives on the instance disk and is cleared when the free service restarts. The free instance also sleeps after inactivity. The first visit wakes it.

| Variable | On Render |
| --- | --- |
| `GROQ_API_KEY` | Required. You paste it in the dashboard. |
| `LLM_PROVIDER`, `LLM_MODE`, `GROQ_MODEL`, `GROQ_BASE_URL`, `GROQ_REASONING_EFFORT` | Set by the blueprint. Groq, tools mode, `openai/gpt-oss-120b`. |
| `CALENDAR_PROVIDER`, `CRM_PROVIDER`, `SMS_PROVIDER`, `EMAIL_PROVIDER` | Set to mock / local. Change them only when you add that provider's keys. |
| `DEMO_SEED`, `BUSINESS_CONFIG`, `STORE_PATH` | Set by the blueprint. |
| `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEETS_ID` | Optional. Without them, calendar and CRM stay local even if you flip the provider. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional. Without all three, texts are only logged. |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | Optional. Without both, email is only logged. |
| `VAPI_WEBHOOK_SECRET`, `VAPI_VOICE_PROVIDER`, `VAPI_VOICE_ID` | Optional. The browser phone does not need them. |
| `PUBLIC_BASE_URL` | Optional. On Render, webhook links fall back to `RENDER_EXTERNAL_URL`. |
| `GEMINI_API_KEY`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET` | Optional. |

## Go live

Do this in accounts the shop owner controls. Put secrets in `.env.local` only.

### 1. Groq

1. Create a free key at [console.groq.com](https://console.groq.com).
2. Set `GROQ_API_KEY` in `.env.local`.
3. Leave `GROQ_MODEL=openai/gpt-oss-120b` unless you have a reason to change it.
4. Restart `npm run demo` and ask Maya something off-script. The call ticket shows `openai/gpt-oss-120b` when Groq answered, and a fallback note when it did not.

### 2. Google Calendar and the call sheet

1. Create a Google Cloud project and enable the Calendar API and the Google Sheets API.
2. Create a service account and download the JSON key.
3. Create a calendar and a spreadsheet. Share both with the service account email, as editor.
4. Name a tab `Calls`. Row 1 headers, in order: Timestamp, Call id, From, Customer, Phone, Service, Status, Appointment, Summary, Channel.
5. Set:

```
CALENDAR_PROVIDER=google
CRM_PROVIDER=google
GOOGLE_CLIENT_EMAIL=the-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=the-calendar-id
GOOGLE_SHEETS_ID=the-spreadsheet-id
```

Keep the `\n` escapes in the private key, on one line. The desk signs its own JWT. It does not add the customer as a calendar guest, because a service account cannot invite people without domain-wide delegation. The email goes in the event description instead.

When Google is on, the sample day is not seeded, so startup does not write real events.

### 3. A phone number

**Vapi, recommended for a natural voice.** The shop gets a US number on Vapi's usage plan, including a small free credit.

1. In Vapi, set the server URL to `https://YOUR_HOST/api/webhooks/vapi`.
2. Or fetch `GET /api/assistant/vapi` and paste that assistant. It already points the model at Groq `openai/gpt-oss-120b` and lists the tools.
3. Set `PUBLIC_BASE_URL` to the public https origin.
4. Optional: `VAPI_WEBHOOK_SECRET`, sent as `x-vapi-secret`.

**Retell.** Point custom functions and call events at `POST /api/webhooks/retell`. Function responses include the spoken line and, for availability, `label | ISO` rows the agent must pass back to `book_appointment`.

**Twilio trial, the cheap path.** Buy or claim a number and set the voice webhook to `POST https://YOUR_HOST/api/webhooks/twilio`. Speech is gathered and spoken with `TWILIO_SAY_VOICE` (default `Polly.Joanna-Neural`). The words come from Groq when the key is set. A transfer becomes `<Dial>` to the shop number in the YAML. Set `TWILIO_AUTH_TOKEN` so signatures are checked. Trial accounts can only call verified numbers.

### 4. Confirmations

```
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

EMAIL_PROVIDER=resend
RESEND_API_KEY=
NOTIFY_FROM_EMAIL=maya@the-shop.com
```

The customer gets a text. The shop inbox gets a copy. If the caller said an email address, they get one too. A failed send does not undo the booking. The outbox shows `failed`.

### 5. Optional n8n

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
| Resend email | $0 under the free tier (3,000 emails/month) |
| Twilio SMS | about $0.008 per message, under $1, plus a trial credit |
| n8n on a machine you already have | $0 |

**About $45 to $70 a month** with Vapi, Groq's free tier, and Google. ElevenLabs on top of Vapi adds roughly $0.02 a minute.

Retell is in the same band: voice infra about $0.055/min plus a platform voice around $0.015/min and a cheap model, US telephony about $0.015/min if you use theirs, number about $2/month, about $10 of starting credit.

The Twilio Gather path skips Vapi. Voice is about $0.0085/min inbound plus $1.15 for the number, and Polly is included in the `<Say>`. Call it **about $10 to $20 a month** plus Groq at $0, with a less natural voice. Use it for a trial, then move the same tools to Vapi when the shop wants the voice to sound like a person.

## Operating notes

- The desk log is `data/store.json`. It is gitignored. **Reset demo** on the dashboard restores the sample morning.
- Sample rows are badged so a live call is obvious next to them.
- A booking is real only after the calendar accepts it. If Groq says someone is booked and no event was created, that turn is thrown out and the built-in receptionist handles it.
- Transfer in the browser does not place a call. It records the number and shows it. Twilio dials.
- `PUBLIC_BASE_URL` must be the public https origin before Twilio or Vapi can reach the webhooks.
