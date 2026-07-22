# CardScan multi-user — deployment

Everything runs on free tiers. Budget ~20 minutes.

## What changes

| Before | After |
|---|---|
| Airtable token stored on each phone | Token lives only in the Worker |
| Anthropic key stored on each phone | Key lives only in the Worker |
| Anyone with the URL can use it | Invite-only, single-use links |
| Everyone sees the same contacts | Each person sees only their own |
| No usage limit | 100 scans per person per day |

## 1. Cloudflare account

Sign up free at https://dash.cloudflare.com/sign-up — no card required for the Workers free tier
(100,000 requests/day, far beyond what this needs).

## 2. Install wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

## 3. Create the KV namespace

```bash
cd /path/to/this/folder
npx wrangler kv namespace create KV
```

It prints something like:

```
id = "a1b2c3d4e5f6..."
```

Paste that id into `wrangler.toml`, replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

## 4. Set the secrets

Run each of these; it will prompt you to paste the value.

```bash
npx wrangler secret put AIRTABLE_TOKEN
npx wrangler secret put ANTHROPIC_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put BOOTSTRAP_SECRET
```

- `AIRTABLE_TOKEN` — the CardScannerToken you already made
- `ANTHROPIC_KEY` — from https://platform.claude.com/settings/keys
- `JWT_SECRET` — any long random string. Generate one: `openssl rand -base64 32`
- `BOOTSTRAP_SECRET` — another random string, used once to create your admin account

## 5. Deploy

```bash
npx wrangler deploy
```

It prints your Worker URL, e.g. `https://cardscan-api.yourname.workers.dev`.
**Save this URL** — it goes into the app.

## 6. Create your admin account

Replace the URL and secret below, then run:

```bash
curl -X POST https://cardscan-api.yourname.workers.dev/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_BOOTSTRAP_SECRET","name":"Ayaz Parbtani"}'
```

It returns a `token`. That's your admin session — you'll paste it into the app once.

**Then rotate the bootstrap secret** so it can't be reused:
```bash
npx wrangler secret put BOOTSTRAP_SECRET
```

## 7. Point the app at the Worker

In `index.html`, set:

```js
const API = 'https://cardscan-api.yourname.workers.dev';
```

Push to GitHub. Pages redeploys in ~2 minutes.

## Daily use

**Inviting someone:** open the app → Settings → *Invite someone* → a link is generated →
share it however you like (WhatsApp, SMS, AirDrop). They open it, type their name, and
they're in. The link dies the moment they use it, or after 48 hours.

**Removing someone:** Settings → *Team* → toggle them off. Their session dies on their
next request. Their already-collected contacts stay in your Airtable.

**Your view:** you see every contact from everyone in the app, and the raw Airtable base
has `Collected By`, `Collector ID`, and `Invited By` columns for sorting, deduping, and
export.

## Security notes

- An invite link is a credential until it's used. Treat it like a password — send it
  directly to the person, not into a group chat.
- Sessions live in each phone's browser storage. If someone clears their browser, they
  need a fresh invite.
- The daily scan cap is per person. Raise it in `worker.js` (`DAILY_SCAN_CAP`) if needed.
- Rotate `JWT_SECRET` to force everyone to re-authenticate at once.
