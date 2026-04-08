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

// ─── Portkey call (raw fetch — SDK doesn't forward custom headers reliably) ───
// modelSpec: "@virtualkey/modelname" or plain model string.
async function callPortkey({ apiKey, modelSpec, messages, max_tokens, system }) {
  modelSpec = modelSpec.trim();
  let virtualKey, model;
  if (modelSpec.startsWith("@")) {
    const slash = modelSpec.indexOf("/", 1);
    virtualKey = modelSpec.slice(1, slash !== -1 ? slash : undefined);
    model = slash !== -1 ? modelSpec.slice(slash + 1) : modelSpec.slice(1);
  } else {
    model = modelSpec;
  }

  const fullMessages = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  // Default virtual key — all models route through anthropic-marlin-tuna unless overridden
  const resolvedVirtualKey = virtualKey || "anthropic-marlin-tuna";

  const headers = {
    "Content-Type": "application/json",
    "x-portkey-api-key": apiKey,
    "x-portkey-virtual-key": resolvedVirtualKey,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch("https://api.portkey.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({ model, messages: fullMessages, max_tokens }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data?.message || "Portkey error"), { status: res.status });
    return data;
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
  const portkeyApiKey = process.env.PORTKEY_API_KEY;

  if (!secret || !portkeyApiKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

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

  // ── 4. Parse body ──
  const { model, messages: rawMessages, prompt, max_tokens = 1024, system } = req.body || {};

  const messages = Array.isArray(rawMessages) && rawMessages.length > 0
    ? rawMessages
    : prompt
      ? [{ role: "user", content: String(prompt) }]
      : null;

  if (!messages) {
    return res.status(400).json({ error: "Body must include a messages array or a prompt string" });
  }

  // Model priority: env override → request model → Anthropic → OpenAI
  const modelCandidates = [
    process.env.ANTHROPIC_MODEL || "@anthropic-marlin-tuna/claude-sonnet-4-6",
    "@anthropic-marlin-tuna/claude-sonnet-4-5",
    "@openai/gpt-4.1",
  ];

  if (process.env.FORCED_MODEL) {
    modelCandidates.unshift(process.env.FORCED_MODEL);
  } else if (model) {
    modelCandidates.unshift(model);
  }

  // ── 5. Call Portkey — try models in order until one succeeds ──
  const tried = new Set();

  for (const candidate of modelCandidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    try {
      const completion = await callPortkey({
        apiKey: portkeyApiKey,
        modelSpec: candidate,
        messages,
        max_tokens,
        system,
      });

      const responseText = completion.choices?.[0]?.message?.content || "";

      return res.status(200).json({
        response: responseText,
        metadata: {
          request_id: completion.id,
          input_tokens: completion.usage?.prompt_tokens,
          output_tokens: completion.usage?.completion_tokens,
          timestamp: new Date().toISOString(),
          model_version: completion.model,
          model: candidate,
        },
      });
    } catch (err) {
      const status = err?.status || err?.response?.status;
      console.error(`Portkey call failed [${candidate}]:`, err?.message || err);
      // On rate-limit or server error, try next model; otherwise bail
      if (status && status !== 429 && status !== 529 && status !== 503) {
        return res.status(status).json({ error: err?.message || "LLM request failed" });
      }
      // rate-limited / overloaded — fall through to next candidate
    }
  }

  return res.status(502).json({ error: "All LLM providers exhausted" });
}
