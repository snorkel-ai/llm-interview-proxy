"""
╔══════════════════════════════════════════════════════════════════════╗
║              INTERVIEW STARTER CODE — Do Not Modify Cell 1          ║
╚══════════════════════════════════════════════════════════════════════╝

Paste this into the candidate's CodePad notebook as the locked first cell.
They never see your real API key — only the proxy URL and a disposable token.
"""

# ── Cell 1 (LOCKED — do not modify) ──────────────────────────────────────────
import time
import requests

BASE_URL = "https://llm-interview-proxy.vercel.app"

# Auto-request an ephemeral session token (expires in 1 hour)
_resp = requests.post(
    f"{BASE_URL}/api/request-key",
    json={"ttl_seconds": 3600, "use_case_id": "team-x1z"}
)
API_KEY = _resp.json()["api_key"]
print(f"✅ Session token issued — expires in 1 hour")


# ── Helper function candidates will use ──────────────────────────────────────
def llm_extraction(tweet: str, system_prompt: str = "") -> str:
    """
    Sends a tweet to the LLM for entity extraction.
    Returns the model's response text.
    Automatically retries on rate-limit (429) errors with exponential backoff.
    """
    max_retries = 6
    for attempt in range(max_retries + 1):
        response = requests.post(
            f"{BASE_URL}/api/inference",
            headers={
                "Content-Type": "application/json",
                "X-API-Key": API_KEY,
                "use-case-id": "team-x1z",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 512,
                "messages": [
                    {"role": "user", "content": f"{system_prompt}\n\nTweet: {tweet}"}
                ],
            },
        )
        if response.status_code == 429 and attempt < max_retries:
            wait = min(2 ** attempt + 0.5, 30)
            print(f"Rate limited — retrying in {wait:.0f}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(wait)
            continue
        response.raise_for_status()
        return response.json()["response"]


# ── Cell 2 (candidates edit this) ────────────────────────────────────────────
SYSTEM_PROMPT = """
[TODO] YOUR PROMPT HERE
"""

# Test it
result = llm_extraction("flying with delta today from atlanta to salt lake!", SYSTEM_PROMPT)
print(result)
