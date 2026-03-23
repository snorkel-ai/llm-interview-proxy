# LLM Interview Proxy

A stateless, zero-database LLM proxy for technical interviews.  
Candidates get ephemeral tokens. Your real API key never leaves Vercel.

---

## How the Token System Works

```
You (interviewer)          Vercel (your proxy)          Anthropic API
      │                          │                            │
      │  Set INTERVIEW_SECRET    │                            │
      │  Set LLM_API_KEY ──────► │ (stored in env vars)      │
      │                          │                            │
Candidate hits CodePad:          │                            │
      │                          │                            │
      ├─ POST /api/request-key ─►│                            │
      │                          │ HMAC-sign(timestamp+TTL)   │
      │◄─ { api_key: "tok_..." } ─┤ using INTERVIEW_SECRET    │
      │                          │                            │
      ├─ POST /api/inference ───►│                            │
      │   X-API-Key: tok_...     │ validate HMAC signature    │
      │   (their prompt)         ├──────────────────────────►│
      │                          │   real LLM_API_KEY (hidden)│
      │◄─ { response: "..." } ───┤◄──────────────────────────┤
```

### The Token is Self-Validating (No Database Needed)

The ephemeral token encodes:
- `use_case_id` — which team/candidate group
- `issued_at` — Unix timestamp of creation  
- `expires_at` — when it dies
- `signature` — HMAC-SHA256 of the above, signed with your `INTERVIEW_SECRET`

When a candidate sends the token, the proxy re-derives the HMAC and compares.  
**If someone tampers with the token, the signature won't match → 401.**  
**If the token is expired, it's rejected → 401.**  
No Redis, no Postgres, no state anywhere.

---

## Setup (5 minutes)

### Step 1 — Clone and push to GitHub

```bash
git clone https://github.com/your-org/llm-interview-proxy
cd llm-interview-proxy
# push to your own repo
```

### Step 2 — Deploy to Vercel

```bash
npm i -g vercel
vercel --prod
```

Or connect your GitHub repo at [vercel.com/new](https://vercel.com/new) — Vercel auto-detects it.

### Step 3 — Set environment variables in Vercel

Go to **Vercel Dashboard → Your Project → Settings → Environment Variables** and add:

| Variable | Value | Notes |
|---|---|---|
| `INTERVIEW_SECRET` | `openssl rand -hex 32` | Random 64-char hex — generate once, never share |
| `LLM_API_KEY` | `sk-ant-...` | Your real Anthropic API key |
| `LLM_BASE_URL` | `https://api.anthropic.com` | Or your custom LLM host |
| `FORCED_MODEL` | `claude-sonnet-4-20250514` | Optional: lock candidates to one model |
| `RATE_LIMIT_PER_TOKEN` | `100` | Optional: max requests per token |
| `ALLOWED_USE_CASE_PATTERN` | `team-` | Optional: only allow team-* use-case IDs |

### Step 4 — Generate your INTERVIEW_SECRET

```bash
# In your terminal — run this once:
openssl rand -hex 32
# Output example: a3f8c2d1e4b7a9f0c3d6e1f2a4b8c9d0e3f6a1b4c7d0e9f2a5b8c1d4e7f0a3b6
```

Paste this into Vercel as `INTERVIEW_SECRET`. Done.  
This is the **only secret you ever manage.** The token candidates receive is derived from it but cannot reveal it.

---

## How to Run an Interview Cohort

### Per cohort (e.g. every hiring batch):

1. Nothing to rotate — tokens expire automatically by TTL
2. Optionally change `use_case_id` per cohort (e.g. `team-jan2026`) for log filtering

### Per candidate:

Nothing — the `/api/request-key` call in Cell 1 of their CodePad handles it automatically.

### If a candidate abuses the token:

Their token is tied to `use_case_id`. You can add a blocklist in `api/inference.js` if needed.  
Or just set `RATE_LIMIT_PER_TOKEN` to something low like `50`.

---

## Endpoints

### `POST /api/request-key`

Generates an ephemeral signed token.

**Request body:**
```json
{
  "ttl_seconds": 3600,
  "use_case_id": "team-x1z"
}
```

**Response:**
```json
{
  "api_key": "dGVhbS14MXo6MTc0...",
  "expires_at": 1743000000,
  "ttl_seconds": 3600,
  "use_case_id": "team-x1z"
}
```

---

### `POST /api/inference`

Proxies to Anthropic. Response shape matches your original `snorkel-a1` format.

**Required headers:**
```
X-API-Key: <token from /api/request-key>
use-case-id: team-x1z
Content-Type: application/json
```

**Request body:**
```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 512,
  "messages": [
    { "role": "user", "content": "Your prompt here" }
  ]
}
```

**Response:**
```json
{
  "response": "The extracted entities are...",
  "metadata": {
    "request_id": "msg_01...",
    "input_tokens": 142,
    "output_tokens": 38,
    "timestamp": "2026-03-23T12:00:00.000Z",
    "model_version": "claude-sonnet-4-20250514",
    "model": "claude-sonnet-4-20250514"
  }
}
```

---

## Local Development

```bash
npm install
vercel dev
# Proxy runs at http://localhost:3000
```

You'll need a `.env.local` file:
```
INTERVIEW_SECRET=your-local-secret
LLM_API_KEY=sk-ant-...
LLM_BASE_URL=https://api.anthropic.com
```

---

## Cost Control Tips

- Set `max_tokens` in `FORCED_MODEL` logic to cap output length
- Set `RATE_LIMIT_PER_TOKEN` to limit requests per session
- Monitor spend in Anthropic console — filter by date to see interview days
- Use `claude-haiku-3-5` instead of Sonnet for cheap high-volume interviews
