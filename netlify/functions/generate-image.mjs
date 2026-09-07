// netlify/functions/generate-image.mjs
//
// Proxies one image-generation request to Cloudflare Workers AI's
// FLUX.2 [klein] 4B model (@cf/black-forest-labs/flux-2-klein-4b).
//
// This exists as a server-side function (rather than calling Cloudflare
// straight from the browser) because it needs your CF_API_TOKEN, which
// must never be exposed to the client.
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

export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST" }, 405);
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return jsonResponse(
      {
        error:
          "Server is missing CF_ACCOUNT_ID / CF_API_TOKEN environment variables. Set them in Netlify's site settings.",
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

  const { prompt, width, height, guidance, seed, referenceImages } = payload || {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return jsonResponse({ error: "\"prompt\" is required" }, 400);
  }

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const cfResponse = await fetch(
      `${CF_ENDPOINT_BASE}/${accountId}/ai/run/${MODEL_ID}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}` },
        body: form,
        signal: controller.signal,
      }
    );

    const contentType = cfResponse.headers.get("content-type") || "";

    // Normal path: Cloudflare wraps the result as { result: { image }, success, errors }.
    if (contentType.includes("application/json")) {
      const data = await cfResponse.json();
      const image = data?.result?.image || data?.image;

      if (!cfResponse.ok || data?.success === false || !image) {
        const message =
          data?.errors?.map((e) => e.message).join("; ") ||
          `Cloudflare returned ${cfResponse.status}`;
        return jsonResponse({ error: message }, cfResponse.status || 502);
      }

      return jsonResponse({ image });
    }

    // Fallback path: some Workers AI image models stream raw bytes back
    // instead of JSON+base64. Handle that too, defensively.
    if (contentType.startsWith("image/")) {
      const buffer = Buffer.from(await cfResponse.arrayBuffer());
      return jsonResponse({ image: buffer.toString("base64") });
    }

    const text = await cfResponse.text();
    return jsonResponse(
      { error: `Unexpected response from Cloudflare: ${text.slice(0, 300)}` },
      502
    );
  } catch (err) {
    const message =
      err.name === "AbortError"
        ? "Request to Cloudflare timed out"
        : err.message || "Unknown error calling Cloudflare";
    return jsonResponse({ error: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
};

export const config = {
  path: "/api/generate-image",
};
