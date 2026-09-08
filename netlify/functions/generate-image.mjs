// netlify/functions/generate-image.mjs
//
// Proxies one image-generation request to Cloudflare Workers AI's
// FLUX.2 [klein] 4B model (@cf/black-forest-labs/flux-2-klein-4b).
//
// Supports multiple Cloudflare accounts as a fallback chain: if the
// account currently in use has run out of its daily free neuron
// allowance (or is briefly rate-limited / times out), the request is
// automatically retried on the next configured account before giving up.
//
// This exists as a server-side function (rather than calling Cloudflare
// straight from the browser) because it needs your CF_API_TOKEN(s),
// which must never be exposed to the client.
//
// --- Configuring accounts ---
// One account (works exactly as before):
//   CF_ACCOUNT_ID=...
//   CF_API_TOKEN=...
//
// Multiple accounts (tried in this order until one succeeds):
//   CF_ACCOUNT_ID_1=...   CF_API_TOKEN_1=...
//   CF_ACCOUNT_ID_2=...   CF_API_TOKEN_2=...
//   CF_ACCOUNT_ID_3=...   CF_API_TOKEN_3=...
//   (as many numbered pairs as you like — the app finds them automatically)
//
// You can mix both styles: an unnumbered pair is tried first, then any
// numbered pairs in order.
//
// Expects a JSON POST body:
//   {
//     "prompt": "a fox reading a book",
//     "width": 1024,            // optional, 256-1920, default 1024
//     "height": 768,            // optional, 256-1920, default 768
//     "guidance": 4.5,          // optional float
//     "seed": 12345,            // optional int
//     "referenceImages": [      // optional, up to 4 data URLs, each <512x512
//       "data:image/png;base64,...."
//     ]
//   }
//
// Returns:
//   { "image": "<base64 PNG>" }              on success
//   { "error": "message" }                    on failure

const CF_ENDPOINT_BASE = "https://api.cloudflare.com/client/v4/accounts";
const MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_REFERENCE_IMAGES = 4;
const REQUEST_TIMEOUT_MS = 45_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// Turns a "data:image/png;base64,AAAA..." string into a Blob Node can send.
function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) {
    throw new Error("Reference image must be a base64 data URL");
  }
  const [, mime, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  return new Blob([buffer], { type: mime });
}

// Reads however many Cloudflare account/token pairs are configured and
// returns them as an ordered list to try. See the header comment above
// for the environment variable naming convention.
function loadAccounts() {
  const accounts = [];

  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) {
    accounts.push({
      accountId: process.env.CF_ACCOUNT_ID,
      apiToken: process.env.CF_API_TOKEN,
      label: "primary",
    });
  }

  const MAX_NUMBERED_ACCOUNTS = 20;
  for (let i = 1; i <= MAX_NUMBERED_ACCOUNTS; i++) {
    if (process.env[`CF_ACCOUNT_ID_${i}`] && process.env[`CF_API_TOKEN_${i}`]) {
      accounts.push({
        accountId: process.env[`CF_ACCOUNT_ID_${i}`],
        apiToken: process.env[`CF_API_TOKEN_${i}`],
        label: `account ${i}`,
      });
    }
  }

  return accounts;
}

function buildForm({ prompt, width, height, guidance, seed, referenceImages }) {
  const form = new FormData();
  form.append("prompt", prompt.trim());
  if (width) form.append("width", String(width));
  if (height) form.append("height", String(height));
  if (guidance !== undefined && guidance !== null && guidance !== "") {
    form.append("guidance", String(guidance));
  }
  if (seed !== undefined && seed !== null && seed !== "") {
    form.append("seed", String(seed));
  }

  if (Array.isArray(referenceImages)) {
    referenceImages.slice(0, MAX_REFERENCE_IMAGES).forEach((dataUrl, i) => {
      try {
        const blob = dataUrlToBlob(dataUrl);
        form.append(`input_image_${i}`, blob, `ref_${i}.png`);
      } catch {
        // Skip a malformed reference image rather than failing the whole job.
      }
    });
  }

  return form;
}

// Tries a single Cloudflare account. `retryable: true` means "this
// account couldn't serve the request right now" (out of quota, rate
// limited, or a timeout) — worth trying the next account for. `false`
// means the request itself was the problem (e.g. bad prompt), so
// retrying on another account would just fail the same way.
async function callAccount(account, payload) {
  const form = buildForm(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const cfResponse = await fetch(
      `${CF_ENDPOINT_BASE}/${account.accountId}/ai/run/${MODEL_ID}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${account.apiToken}` },
        body: form,
        signal: controller.signal,
      }
    );

    const contentType = cfResponse.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await cfResponse.json();
      const image = data?.result?.image || data?.image;
      const rateLimited = cfResponse.status === 429;

      if (!cfResponse.ok || data?.success === false || !image) {
        const message =
          data?.errors?.map((e) => e.message).join("; ") ||
          `Cloudflare returned ${cfResponse.status}`;
        return {
          ok: false,
          retryable: rateLimited,
          status: cfResponse.status || 502,
          message,
        };
      }

      return { ok: true, image };
    }

    // Fallback path: some Workers AI image models stream raw bytes back
    // instead of JSON+base64. Handle that too, defensively.
    if (contentType.startsWith("image/")) {
      const buffer = Buffer.from(await cfResponse.arrayBuffer());
      return { ok: true, image: buffer.toString("base64") };
    }

    const text = await cfResponse.text();
    return {
      ok: false,
      retryable: cfResponse.status === 429,
      status: 502,
      message: `Unexpected response from Cloudflare: ${text.slice(0, 300)}`,
    };
  } catch (err) {
    const message =
      err.name === "AbortError"
        ? "Request to Cloudflare timed out"
        : err.message || "Unknown error calling Cloudflare";
    // Network errors / timeouts are also worth retrying on another account.
    return { ok: false, retryable: true, status: 500, message };
  } finally {
    clearTimeout(timeout);
  }
}

export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST" }, 405);
  }

  const accounts = loadAccounts();
  if (!accounts.length) {
    return jsonResponse(
      {
        error:
          "Server has no Cloudflare accounts configured. Set CF_ACCOUNT_ID / CF_API_TOKEN " +
          "(and optionally CF_ACCOUNT_ID_2 / CF_API_TOKEN_2, CF_ACCOUNT_ID_3 / CF_API_TOKEN_3, ...) " +
          "in Netlify's site settings.",
      },
      500
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }

  const { prompt } = payload || {};
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return jsonResponse({ error: '"prompt" is required' }, 400);
  }

  let lastError = null;

  for (const account of accounts) {
    const result = await callAccount(account, payload);

    if (result.ok) {
      return jsonResponse({ image: result.image });
    }

    lastError = result;

    if (!result.retryable) {
      // A real problem with the request itself — trying another account
      // won't fix it, so stop here instead of burning everyone's quota.
      return jsonResponse({ error: result.message }, result.status);
    }
    // Otherwise this account is out of quota / rate-limited / timed out —
    // loop continues to the next configured account, if there is one.
  }

  return jsonResponse(
    {
      error: `All ${accounts.length} Cloudflare account(s) are unavailable right now. Last error: ${lastError?.message}`,
    },
    503
  );
};

export const config = {
  path: "/api/generate-image",
};
