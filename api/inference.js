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
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_TOKEN) || 50; // max requests per token lifetime

function checkRateLimit(token) {
  const count = requestCounts.get(token) || 0;
  if (count >= RATE_LIMIT) return false;
  requestCounts.set(token, count + 1);
  return true;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.INTERVIEW_SECRET;
  const realApiKey = process.env.LLM_API_KEY; // Your real Anthropic key — never exposed
  const llmBaseUrl = process.env.LLM_BASE_URL || "https://api.anthropic.com";

  if (!secret || !realApiKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

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
  const { model, messages, max_tokens = 1024, system, ...rest } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Body must include a messages array" });
  }

  // Force a safe model if you want to lock candidates to a specific one
  const allowedModel = process.env.FORCED_MODEL || model || "claude-sonnet-4-20250514";

  // ── 5. Proxy to Anthropic ──
  try {
    const upstream = await fetch(`${llmBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": realApiKey,          // Real key — never sent to candidate
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: allowedModel,
        max_tokens,
        messages,
        ...(system ? { system } : {}),
        ...rest,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data });
    }

    // ── 6. Return in your original snorkel-a1 response shape ──
    //    So candidates don't need to change their parsing code
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
        model: allowedModel,
      },
    });
  } catch (err) {
    console.error("Upstream LLM error:", err);
    return res.status(502).json({ error: "Upstream LLM request failed" });
  }
}
