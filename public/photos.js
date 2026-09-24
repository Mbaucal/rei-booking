// Only processed JPEGs leave the browser. Originals are never uploaded.
const MAX_FILE = 10 * 1024 * 1024;
export async function processPhoto(file) {
  if (!file || file.size === 0 || file.size > MAX_FILE)
    throw new Error("Choose an image up to 10 MB.");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png =
    head.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => head[i] === v);
  const jpg = head[0] === 255 && head[1] === 216 && head[2] === 255;
  const webp =
    head.length === 12 &&
    String.fromCharCode(...head.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...head.slice(8)) === "WEBP";
  const type = jpg
    ? "image/jpeg"
    : png
      ? "image/png"
      : webp
        ? "image/webp"
        : null;
  if (!type || (file.type && file.type !== type))
    throw new Error("Choose a JPG, PNG or WebP image.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "This image could not be opened. Try another JPG, PNG or WebP.",
    );
  }
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 40000000
    )
      throw new Error("Choose an image with at most 40 megapixels.");
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("Photo processing is unavailable in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let result;
    for (const quality of [0.88, 0.75, 0.6]) {
      result = canvas.toDataURL("image/jpeg", quality);
      if (
        result.startsWith("data:image/jpeg;base64,") &&
        result.length < 195000
      )
        break;
    }
    if (
      !result?.startsWith("data:image/jpeg;base64,") ||
      result.length >= 195000
    )
      throw new Error("This image is too detailed. Try a smaller photo.");
    return result;
  } finally {
    bitmap.close();
  }
}
export function photoURL(kind, record) {
  return `/api/photos/${kind}/${encodeURIComponent(record.id)}?v=${record.photoVersion || 0}`;
}
export function avatar(kind, record, esc) {
  const initials = esc(record.name?.slice(0, 2) || "?");
  return `<span class="avatar"><span>${initials}</span>${record.hasPhoto ? `<img src="${photoURL(kind, record)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;
}
// Async image processing must not revive a removed selection or another profile.
export function createPhotoDraft(
  initial,
  version,
  current,
  process = processPhoto,
) {
  let sequence = 0,
    busy = false,
    value = initial,
    changed = false;
  return {
    async choose(file) {
      const n = ++sequence;
      busy = true;
      try {
        const result = await process(file);
        if (n !== sequence || !current()) return false;
        value = result;
        changed = true;
        return true;
      } catch (error) {
        if (n !== sequence || !current()) return false;
        throw error;
      } finally {
        if (n === sequence) busy = false;
      }
    },
    remove() {
      sequence++;
      busy = false;
      value = null;
      changed = true;
    },
    undo() {
      sequence++;
      busy = false;
      value = initial;
      changed = false;
    },
    get value() {
      return value;
    },
    get busy() {
      return busy;
    },
    get changed() {
      return changed;
    },
    payload() {
      if (busy) throw new Error("Wait for the photo preview to finish.");
      if (!current()) throw new Error("Reopen the profile before saving.");
      return changed
        ? { version, data: value ? value.split(",")[1] : null }
        : undefined;
    },
  };
}
export function mountPhotoEditor(container, record, kind, esc, isCurrent) {
  const current = () => container.isConnected && isCurrent();
  const initial = record?.hasPhoto ? photoURL(kind, record) : null;
  const draft = createPhotoDraft(initial, record?.photoVersion || 0, current);
  container.innerHTML = `<div class="photo-editor"><div class="photo-preview"></div><div><label class="btn photo-upload">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose profile photo"></label><div class="photo-actions"><button type="button" class="btn" data-remove>Remove</button><button type="button" class="btn" data-undo>Undo</button></div><p class="hint">JPG, PNG or WebP · up to 10 MB. Saved with this form.</p><p class="hint" data-photo-status role="status"></p></div></div>`;
  const preview = container.querySelector(".photo-preview"),
    status = container.querySelector("[data-photo-status]"),
    file = container.querySelector("input");
  const paint = () => {
    preview.innerHTML = `<span class="avatar"><span>${esc(record?.name?.slice(0, 2) || "?")}</span>${draft.value ? `<img src="${esc(draft.value)}" alt="Selected profile photo">` : ""}</span>`;
    container.querySelector("[data-remove]").disabled = !draft.value;
    container.querySelector("[data-undo]").disabled =
      !draft.changed && !draft.busy;
  };
  file.onchange = async () => {
    const picked = file.files[0];
    file.value = "";
    if (!picked) return;
    status.textContent = "Preparing photo…";
    const promise = draft.choose(picked);
    paint();
    try {
      if (await promise) {
        paint();
        status.textContent = "Preview ready. Save to keep this photo.";
      }
    } catch (e) {
      if (current()) {
        status.textContent = e.message;
        paint();
      }
    }
  };
  container.querySelector("[data-remove]").onclick = () => {
    draft.remove();
    paint();
    status.textContent = "Photo will be removed when you save.";
  };
  container.querySelector("[data-undo]").onclick = () => {
    draft.undo();
    paint();
    status.textContent = "Original photo restored.";
  };
  paint();
  return draft;
}
