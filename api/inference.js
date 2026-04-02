import crypto from "crypto";

/**
 * POST /api/inference
 *
 * Validates the candidate's ephemeral token, then proxies
 * the request to Anthropic (or any LLM backend) using the
 * real API key stored securely in Vercel env vars.
 *
 * Required headers:
 *   X-API-Key      — ephemeral token from /api/request-key
 *   use-case-id    — must match a pattern you allow (e.g. "team-x1z")
 *   Content-Type   — application/json
 *
 * Body: standard Anthropic /v1/messages payload
 */

// ─── Token validation (stateless HMAC) ────────────────────────────────────────

function validateToken(token, secret) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return { valid: false, reason: "Malformed token" };

    const [useCaseId, issuedAt, expiresAt, signature] = parts;
    const now = Math.floor(Date.now() / 1000);

    // Check expiry
    if (now > Number(expiresAt)) {
      return { valid: false, reason: "Token expired" };
    }

    // Re-derive expected signature
    const payload = `${useCaseId}:${issuedAt}:${expiresAt}`;
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    // Constant-time comparison to prevent timing attacks
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

// ─── Rate-limit guard (simple in-memory — resets per cold start) ──────────────
// For production, swap this with Vercel KV or Upstash Redis.
const requestCounts = new Map();
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_TOKEN) || 200; // max requests per token lifetime

function checkRateLimit(token) {
  const count = requestCounts.get(token) || 0;
  if (count >= RATE_LIMIT) return false;
  requestCounts.set(token, count + 1);
  return true;
}

// ─── Provider helpers ──────────────────────────────────────────────────────────

async function callAnthropic({ apiKey, baseUrl, model, messages, max_tokens, system, rest }) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
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
}

async function callOpenAI({ apiKey, model, messages, max_tokens, system }) {
  // Convert Anthropic-style system param → OpenAI system message
  const oaiMessages = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: oaiMessages, max_tokens }),
  });
  const data = await response.json();
  return { response, data };
}

function normalizeOpenAIResponse(data, model) {
  const text = data.choices?.[0]?.message?.content || "";
  return {
    response: text,
    metadata: {
      request_id: data.id,
      input_tokens: data.usage?.prompt_tokens,
      output_tokens: data.usage?.completion_tokens,
      timestamp: new Date().toISOString(),
      model_version: data.model,
      model,
      provider: "openai",
    },
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.INTERVIEW_SECRET;
  const anthropicBaseUrl = process.env.LLM_BASE_URL || "https://api.anthropic.com";

  // OpenAI keys — primary provider (round-robin)
  const openaiKeys = [
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_API_KEY_1,
    process.env.OPENAI_API_KEY_2,
  ].filter(Boolean);

  // Anthropic keys — fallback provider
  const anthropicKeys = [
    process.env.LLM_API_KEY,
    process.env.LLM_API_KEY_1,
    process.env.LLM_API_KEY_2,
    process.env.LLM_API_KEY_3,
    process.env.LLM_API_KEY_4,
    process.env.LLM_API_KEY_5,
  ].filter(Boolean);

  if (!secret || (anthropicKeys.length === 0 && openaiKeys.length === 0)) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Round-robin counters
  if (!globalThis._anthropicKeyIndex) globalThis._anthropicKeyIndex = 0;
  if (!globalThis._openaiKeyIndex) globalThis._openaiKeyIndex = 0;
  const pickAnthropicKey = () => {
    const key = anthropicKeys[globalThis._anthropicKeyIndex % anthropicKeys.length];
    globalThis._anthropicKeyIndex++;
    return key;
  };
  const pickOpenAIKey = () => {
    const key = openaiKeys[globalThis._openaiKeyIndex % openaiKeys.length];
    globalThis._openaiKeyIndex++;
    return key;
  };

  // ── 1. Validate ephemeral token ──
  const token = req.headers["x-api-key"];
  if (!token) {
    return res.status(401).json({ error: "Missing X-API-Key header. Get a token from /api/request-key first." });
  }

  const validation = validateToken(token, secret);
  if (!validation.valid) {
    return res.status(401).json({ error: `Unauthorized: ${validation.reason}` });
  }

  // ── 2. Check use-case-id (optional scope enforcement) ──
  const useCaseId = req.headers["use-case-id"];
  const allowedPattern = process.env.ALLOWED_USE_CASE_PATTERN || "team-";
  if (useCaseId && !useCaseId.startsWith(allowedPattern)) {
    return res.status(403).json({ error: `Forbidden: use-case-id must start with "${allowedPattern}"` });
  }

  // ── 3. Rate limit ──
  if (!checkRateLimit(token)) {
    return res.status(429).json({ error: `Rate limit exceeded: max ${RATE_LIMIT} requests per token` });
  }

  // ── 4. Parse and sanitize the request body ──
  const { model, messages: rawMessages, prompt, max_tokens = 1024, system, ...rest } = req.body || {};

  // Accept either a messages array OR a plain prompt string
  const messages = rawMessages && Array.isArray(rawMessages)
    ? rawMessages
    : prompt
      ? [{ role: "user", content: String(prompt) }]
      : null;

  if (!messages) {
    return res.status(400).json({ error: "Body must include a messages array or a prompt string" });
  }

  const openaiModel = process.env.OPENAI_PRIMARY_MODEL || "gpt-4o";
  const anthropicModel = process.env.ANTHROPIC_FALLBACK_MODEL || model || "claude-sonnet-4-20250514";

  const MAX_RETRIES = 5;

  try {
    // ── 5a. Try OpenAI first ──
    if (openaiKeys.length > 0) {
      let oaiUpstream, oaiData;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        ({ response: oaiUpstream, data: oaiData } = await callOpenAI({
          apiKey: pickOpenAIKey(),
          model: openaiModel,
          messages,
          max_tokens,
          system,
        }));

        if (oaiUpstream.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = oaiUpstream.headers.get("retry-after");
          const delay = retryAfter
            ? Number(retryAfter) * 1000
            : Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }

      if (oaiUpstream.ok) {
        return res.status(200).json(normalizeOpenAIResponse(oaiData, openaiModel));
      }

      // Non-429 OpenAI error with no Anthropic fallback → return it
      if (oaiUpstream.status !== 429 || anthropicKeys.length === 0) {
        return res.status(oaiUpstream.status).json({ error: oaiData });
      }

      console.warn(`OpenAI exhausted (${oaiUpstream.status}), falling back to Anthropic`);
    }

    // ── 5b. Fallback to Anthropic ──
    if (anthropicKeys.length === 0) {
      return res.status(503).json({ error: "All providers unavailable" });
    }

    let upstream, data;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      ({ response: upstream, data } = await callAnthropic({
        apiKey: pickAnthropicKey(),
        baseUrl: anthropicBaseUrl,
        model: anthropicModel,
        messages,
        max_tokens,
        system,
        rest,
      }));

      if ((upstream.status === 429 || upstream.status === 529) && attempt < MAX_RETRIES) {
        const retryAfter = upstream.headers.get("retry-after");
        const delay = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
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
        provider: "anthropic",
      },
    });

  } catch (err) {
    console.error("Upstream LLM error:", err);
    return res.status(502).json({ error: "Upstream LLM request failed" });
  }
}
