import crypto from "crypto";

// ─── Token validation (stateless HMAC) ────────────────────────────────────────

function validateToken(token, secret) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return { valid: false, reason: "Malformed token" };

    const [useCaseId, issuedAt, expiresAt, signature] = parts;
    const now = Math.floor(Date.now() / 1000);

    if (now > Number(expiresAt)) {
      return { valid: false, reason: "Token expired" };
    }

    const payload = `${useCaseId}:${issuedAt}:${expiresAt}`;
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSig, "hex");
    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return { valid: false, reason: "Invalid signature" };
    }

    return { valid: true, useCaseId, expiresAt: Number(expiresAt) };
  } catch {
    return { valid: false, reason: "Token parse error" };
  }
}

// ─── Rate-limit guard ─────────────────────────────────────────────────────────
const requestCounts = new Map();
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_TOKEN) || 500;

function checkRateLimit(token) {
  const count = requestCounts.get(token) || 0;
  if (count >= RATE_LIMIT) return false;
  requestCounts.set(token, count + 1);
  return true;
}

// ─── Anthropic call with per-request timeout ──────────────────────────────────
async function callAnthropic({ apiKey, model, messages, max_tokens, system, rest }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 15s hard timeout

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        messages,
        ...(system ? { system } : {}),
        ...rest,
      }),
    });
    const data = await response.json();
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.INTERVIEW_SECRET;

  // All Anthropic keys — round-robined to spread rate limit across keys
  const anthropicKeys = [
    process.env.LLM_API_KEY,
    process.env.LLM_API_KEY_1,
    process.env.LLM_API_KEY_2,
    process.env.LLM_API_KEY_3,
    process.env.LLM_API_KEY_4,
    process.env.LLM_API_KEY_5,
  ].filter(Boolean);

  if (!secret || anthropicKeys.length === 0) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (!globalThis._keyIndex) globalThis._keyIndex = 0;
  const pickKey = () => {
    const key = anthropicKeys[globalThis._keyIndex % anthropicKeys.length];
    globalThis._keyIndex++;
    return key;
  };

  // ── 1. Validate token ──
  const token = req.headers["x-api-key"];
  if (!token) {
    return res.status(401).json({ error: "Missing X-API-Key header." });
  }
  const validation = validateToken(token, secret);
  if (!validation.valid) {
    return res.status(401).json({ error: `Unauthorized: ${validation.reason}` });
  }

  // ── 2. use-case-id check ──
  const useCaseId = req.headers["use-case-id"];
  const allowedPattern = process.env.ALLOWED_USE_CASE_PATTERN || "team-";
  if (useCaseId && !useCaseId.startsWith(allowedPattern)) {
    return res.status(403).json({ error: `Forbidden: use-case-id must start with "${allowedPattern}"` });
  }

  // ── 3. Rate limit ──
  if (!checkRateLimit(token)) {
    return res.status(429).json({ error: `Rate limit exceeded: max ${RATE_LIMIT} requests per token` });
  }

  // ── 4. Parse body — accept messages array OR plain prompt string ──
  const { model, messages: rawMessages, prompt, max_tokens = 1024, system, ...rest } = req.body || {};

  const messages = Array.isArray(rawMessages) && rawMessages.length > 0
    ? rawMessages
    : prompt
      ? [{ role: "user", content: String(prompt) }]
      : null;

  if (!messages) {
    return res.status(400).json({ error: "Body must include a messages array or a prompt string" });
  }

  const anthropicModel = process.env.ANTHROPIC_MODEL || model || "claude-haiku-4-5-20251001";

  // ── 5. Call Anthropic — rotate keys on each retry, no long waits ──
  const MAX_RETRIES = 4;

  try {
    let upstream, data;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      ({ response: upstream, data } = await callAnthropic({
        apiKey: pickKey(),
        model: anthropicModel,
        messages,
        max_tokens,
        system,
        rest,
      }));

      if ((upstream.status === 429 || upstream.status === 529) && attempt < MAX_RETRIES) {
        // Respect retry-after if given, otherwise wait 1s then try next key
        const retryAfter = upstream.headers.get("retry-after");
        const delay = retryAfter ? Number(retryAfter) * 1000 : 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data });
    }

    const responseText =
      data.content?.map((b) => (b.type === "text" ? b.text : "")).join("") || "";

    return res.status(200).json({
      response: responseText,
      metadata: {
        request_id: data.id,
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
        timestamp: new Date().toISOString(),
        model_version: data.model,
        model: anthropicModel,
      },
    });

  } catch (err) {
    console.error("Anthropic error:", err);
    return res.status(502).json({ error: "LLM request failed" });
  }
}
