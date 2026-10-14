// Shared UI helpers: escaping, icons, the clare mark, copy-to-clipboard, toasts.

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// One stroke family: 24px grid, 1.75 stroke, round joins.
const PATHS = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><circle cx="6.5" cy="6.8" r=".6" fill="currentColor"/><circle cx="8.8" cy="6.8" r=".6" fill="currentColor"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4M12 16.8v.2"/>',
  unplug: '<path d="M9 7V3.5M15 7V3.5M7 7h10v3.5a5 5 0 0 1-10 0z"/><path d="M12 15.5V20"/><path d="M4 4l16 16"/>',
  plug: '<path d="M9 7V3.5M15 7V3.5M7 7h10v3.5a5 5 0 0 1-10 0z"/><path d="M12 15.5V20.5"/>',
  meter: '<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 16l3.5-5"/><path d="M10 19.5h4"/>',
  shield: '<path d="M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5z"/><path d="M12 9v3.5M12 15.3v.2"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
  play: '<path d="M8 6l10 6-10 6z"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7"/>',
  link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  message: '<path d="M5 18.5l1-3.4A7.5 7.5 0 1 1 9 18z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H10"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4.5V8h-3.5"/>',
  logout: '<path d="M14 7V5.5A1.5 1.5 0 0 0 12.5 4h-6A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h6a1.5 1.5 0 0 0 1.5-1.5V17"/><path d="M10 12h10M17 9l3 3-3 3"/>',
  download: '<path d="M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  phone: '<rect x="7" y="3.5" width="10" height="17" rx="2.5"/><path d="M11 17.5h2"/>',
  laptop: '<rect x="5" y="5.5" width="14" height="10" rx="1.5"/><path d="M3 18.5h18"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  sparkle: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/>',
  edit: '<path d="M5 19l1-4.2L15.6 5.2a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L9.2 18z"/><path d="M13.8 7l3.2 3.2"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
};

export function icon(name, size = 20, extraClass = "") {
  return `<svg class="icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ""}</svg>`;
}

/** The clare mark: a ring split into a 3/4 accent arc and a 1/4 lighter arc. */
export function markSvg(size = 28) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <g transform="rotate(-90 16 16)" fill="none" stroke-width="5.5">
      <circle cx="16" cy="16" r="10.5" pathLength="100" stroke="var(--accent)" stroke-dasharray="73 27"/>
      <circle cx="16" cy="16" r="10.5" pathLength="100" stroke="var(--mark-light)" stroke-dasharray="21 79" stroke-dashoffset="-76"/>
    </g>
  </svg>`;
}

export function wordmark(href = "index.html") {
  return `<a class="wordmark" href="${esc(href)}" aria-label="clare home">${markSvg(26)}<span>clare</span></a>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Wire a button so clicking copies `getText()` and flips its label to "Copied" briefly. */
export function bindCopy(button, getText, { label = "Copy", done = "Copied" } = {}) {
  let timer;
  button.addEventListener("click", async () => {
    const ok = await copyText(getText());
    clearTimeout(timer);
    if (ok) {
      button.classList.add("is-copied");
      button.innerHTML = `${icon("check", 18)}<span>${esc(done)}</span>`;
      announce(`${done}.`);
    } else {
      toast("Couldn't copy automatically. Select the text and copy it.");
    }
    timer = setTimeout(() => {
      button.classList.remove("is-copied");
      button.innerHTML = `${icon("copy", 18)}<span>${esc(label)}</span>`;
    }, 2400);
  });
}

let liveRegion;
export function announce(message) {
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.className = "sr-only";
    liveRegion.setAttribute("aria-live", "polite");
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = "";
  requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

let toastTimer;
export function toast(message, { tone = "neutral" } = {}) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.dataset.tone = tone;
  el.textContent = message;
  el.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-shown"), 4200);
}

export function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(busyLabel || "Working…")}</span>`;
  } else {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}
