import crypto from "crypto";

/**
 * POST /api/request-key
 *
 * Generates a short-lived, HMAC-signed interview token.
 * No database needed — the token is self-validating via signature.
 *
 * Optional body: { ttl_seconds: 3600, use_case_id: "team-x1z" }
 */
export default function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.INTERVIEW_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Server misconfigured: missing INTERVIEW_SECRET" });
  }

  const { ttl_seconds = 3600, use_case_id = "default" } = req.body || {};

  // Build the token payload: issuedAt + expiry + use_case_id
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + Number(ttl_seconds);
  const payload = `${use_case_id}:${issuedAt}:${expiresAt}`;

  // Sign with HMAC-SHA256 using your secret (stored only in Vercel env vars)
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Final token: base64-encode the payload + signature so it's one clean string
  const token = Buffer.from(`${payload}:${signature}`).toString("base64url");

  return res.status(200).json({
    api_key: token,
    expires_at: expiresAt,
    ttl_seconds: Number(ttl_seconds),
    use_case_id,
    message: "Token is valid for the duration specified. Pass it as X-API-Key on /api/inference.",
  });
}
