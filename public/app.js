// public/app.js
// No build step, no framework — just the DOM, fetch, and JSZip (loaded via CDN in index.html).

const CONCURRENCY = 2; // simultaneous requests to Cloudflare; keep modest to avoid timeouts
const MAX_REFERENCES = 4;
const MAX_REFERENCE_DIMENSION = 512; // Cloudflare requires reference images under 512x512

const els = {
  promptsInput: document.getElementById("promptsInput"),
  promptCount: document.getElementById("promptCount"),
  dropzone: document.getElementById("dropzone"),
  dropzonePrompt: document.getElementById("dropzonePrompt"),
  fileInput: document.getElementById("fileInput"),
  referenceThumbs: document.getElementById("referenceThumbs"),
  widthInput: document.getElementById("widthInput"),
  heightInput: document.getElementById("heightInput"),
  guidanceInput: document.getElementById("guidanceInput"),
  seedInput: document.getElementById("seedInput"),
  seedNote: document.getElementById("seedNote"),
  generateBtn: document.getElementById("generateBtn"),
  clearBtn: document.getElementById("clearBtn"),
  formError: document.getElementById("formError"),
  resultsGrid: document.getElementById("resultsGrid"),
  emptyState: document.getElementById("emptyState"),
  cardTemplate: document.getElementById("cardTemplate"),
  downloadBtn: document.getElementById("downloadBtn"),
  downloadCount: document.getElementById("downloadCount"),
  badgeQueued: document.querySelector('[data-role="badge-queued"]'),
  badgeRunning: document.querySelector('[data-role="badge-running"]'),
  badgeDone: document.querySelector('[data-role="badge-done"]'),
  badgeError: document.querySelector('[data-role="badge-error"]'),
};

let referenceImages = []; // [{ dataUrl }]
let jobs = []; // [{ id, index, prompt, status, dataUrl, error, cardEl }]
let isRunning = false;

init();

function init() {
  els.seedNote.textContent =
    "Leave seed blank for a different result on every prompt. A fixed seed is reused across the whole batch.";

  els.promptsInput.addEventListener("input", updatePromptCount);
  updatePromptCount();

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

  ["dragenter", "dragover"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("is-dragover");
    })
  );
  els.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

  els.generateBtn.addEventListener("click", startBatch);
  els.clearBtn.addEventListener("click", clearResults);
  els.downloadBtn.addEventListener("click", downloadZip);

  renderReferenceThumbs();
}

function updatePromptCount() {
  const n = parsePrompts(els.promptsInput.value).length;
  els.promptCount.textContent = `${n} prompt${n === 1 ? "" : "s"}`;
}

function parsePrompts(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/* ---------------------------------------------------------------
   Reference images
------------------------------------------------------------------ */

function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
  const room = MAX_REFERENCES - referenceImages.length;
  files.slice(0, room).forEach(readAndMaybeResize);
  els.fileInput.value = "";
}

function readAndMaybeResize(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const needsResize = img.naturalWidth > MAX_REFERENCE_DIMENSION || img.naturalHeight > MAX_REFERENCE_DIMENSION;
      const dataUrl = needsResize ? resizeToDataUrl(img) : reader.result;
      referenceImages.push({ dataUrl });
      renderReferenceThumbs();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function resizeToDataUrl(img) {
  const scale = MAX_REFERENCE_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function renderReferenceThumbs() {
  els.referenceThumbs.innerHTML = "";
  referenceImages.forEach((ref, i) => {
    const wrap = document.createElement("div");
    wrap.className = "ref-thumb";

    const img = document.createElement("img");
    img.src = ref.dataUrl;
    img.alt = `Reference ${i + 1}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove reference ${i + 1}`);
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      referenceImages.splice(i, 1);
      renderReferenceThumbs();
    });

    wrap.append(img, remove);
    els.referenceThumbs.appendChild(wrap);
  });

  els.dropzonePrompt.hidden = referenceImages.length >= MAX_REFERENCES;
  if (referenceImages.length >= MAX_REFERENCES) {
    els.dropzonePrompt.querySelector("span").textContent = "Maximum of 4 reference images reached";
    els.dropzonePrompt.hidden = false;
  } else {
    els.dropzonePrompt.querySelector("span").textContent = "Drop images here, or click to browse";
  }
}

/* ---------------------------------------------------------------
   Batch run
------------------------------------------------------------------ */

function startBatch() {
  hideError();
  const prompts = parsePrompts(els.promptsInput.value);

  if (!prompts.length) {
    showError("Add at least one prompt — one per line.");
    return;
  }
  if (isRunning) return;

  const settings = readSettings();
  if (settings.error) {
    showError(settings.error);
    return;
  }

  jobs = prompts.map((prompt, index) => ({
    id: `${Date.now()}-${index}`,
    index,
    prompt,
    status: "queued",
    dataUrl: null,
    error: null,
    cardEl: null,
  }));

  els.emptyState.remove();
  els.resultsGrid.innerHTML = "";
  jobs.forEach((job) => els.resultsGrid.appendChild(buildCard(job)));

  updateBadges();
  runBatch(settings);
}

function readSettings() {
  const width = clampInt(els.widthInput.value, 256, 1920, 1024);
  const height = clampInt(els.heightInput.value, 256, 1920, 768);
  const guidance = els.guidanceInput.value.trim();
  const seed = els.seedInput.value.trim();
  return { width, height, guidance, seed };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function runBatch(settings) {
  setRunningUI(true);

  await runPool(
    jobs,
    (job) => runJob(job, settings),
    CONCURRENCY
  );

  setRunningUI(false);
}

async function runPool(items, worker, concurrency) {
  let cursor = 0;
  async function next() {
    if (cursor >= items.length) return;
    const item = items[cursor++];
    await worker(item);
    return next();
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(lanes);
}

async function runJob(job, settings) {
  setJobStatus(job, "processing");

  try {
    const res = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: job.prompt,
        width: settings.width,
        height: settings.height,
        guidance: settings.guidance || undefined,
        seed: settings.seed || undefined,
        referenceImages: referenceImages.map((r) => r.dataUrl),
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    job.dataUrl = `data:image/png;base64,${data.image}`;
    setJobStatus(job, "done");
  } catch (err) {
    job.error = err.message || "Something went wrong";
    setJobStatus(job, "error");
  }
}

function retryJob(job, settings) {
  runJob(job, settings).then(updateBadges);
}

/* ---------------------------------------------------------------
   Card rendering
------------------------------------------------------------------ */

function buildCard(job) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.status = job.status;
  node.querySelector(".card__index").textContent = String(job.index + 1).padStart(2, "0");
  node.querySelector(".card__prompt").textContent = job.prompt;

  const retryBtn = node.querySelector(".card__retry");
  retryBtn.addEventListener("click", () => retryJob(job, readSettings()));

  job.cardEl = node;
  refreshCard(job);
  return node;
}

function setJobStatus(job, status) {
  job.status = status;
  refreshCard(job);
  updateBadges();
}

function refreshCard(job) {
  const node = job.cardEl;
  if (!node) return;
  node.dataset.status = job.status;

  const img = node.querySelector(".card__image");
  const label = node.querySelector(".card__status-label");
  const errorEl = node.querySelector(".card__error");
  const retryBtn = node.querySelector(".card__retry");

  const labels = {
    queued: "waiting",
    processing: "generating…",
    done: "",
    error: "failed",
  };
  label.textContent = labels[job.status] || "";

  if (job.status === "done" && job.dataUrl) {
    img.src = job.dataUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  errorEl.hidden = job.status !== "error";
  errorEl.textContent = job.status === "error" ? job.error : "";
  retryBtn.hidden = job.status !== "error";
}

function updateBadges() {
  const counts = { queued: 0, processing: 0, done: 0, error: 0 };
  jobs.forEach((j) => counts[j.status]++);

  setBadge(els.badgeQueued, counts.queued, `${counts.queued} waiting`);
  setBadge(els.badgeRunning, counts.processing, `${counts.processing} generating`);
  setBadge(els.badgeDone, counts.done, `${counts.done} done`);
  setBadge(els.badgeError, counts.error, `${counts.error} failed`);

  els.downloadCount.textContent = counts.done;
  els.downloadBtn.hidden = counts.done === 0;
}

function setBadge(el, count, text) {
  el.hidden = count === 0;
  el.textContent = text;
}

function setRunningUI(running) {
  isRunning = running;
  els.generateBtn.disabled = running;
  els.clearBtn.disabled = running;
  els.promptsInput.disabled = running;
  els.generateBtn.textContent = running ? "Generating…" : "Generate batch";
}

/* ---------------------------------------------------------------
   Clear / download
------------------------------------------------------------------ */

function clearResults() {
  if (isRunning) return;
  jobs = [];
  els.resultsGrid.innerHTML = "";
  els.resultsGrid.appendChild(els.emptyState);
  updateBadges();
}

async function downloadZip() {
  const done = jobs.filter((j) => j.status === "done");
  if (!done.length) return;

  els.downloadBtn.disabled = true;
  els.downloadBtn.textContent = "Zipping…";

  try {
    const zip = new JSZip();
    const manifestLines = [];

    jobs.forEach((job) => {
      const n = String(job.index + 1).padStart(2, "0");
      if (job.status === "done") {
        const base64 = job.dataUrl.split(",")[1];
        zip.file(`${n}-${slugify(job.prompt)}.png`, base64, { base64: true });
        manifestLines.push(`${n}: ${job.prompt}`);
      } else {
        manifestLines.push(`${n}: ${job.prompt}  [${job.status.toUpperCase()}${job.error ? ": " + job.error : ""}]`);
      }
    });

    zip.file("prompts.txt", manifestLines.join("\n"));

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flux-batch-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    els.downloadBtn.disabled = false;
    els.downloadBtn.innerHTML = `Download <span id="downloadCount">${done.length}</span> images`;
    els.downloadCount = document.getElementById("downloadCount");
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";
}

/* ---------------------------------------------------------------
   Form error banner
------------------------------------------------------------------ */

function showError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function hideError() {
  els.formError.hidden = true;
}
