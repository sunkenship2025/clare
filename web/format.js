// Formatting helpers: percentages, relative times, friendly local dates.

export function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (n > 0 && n < 1) return "<1%";
  return `${Math.round(n)}%`;
}

/**
 * Points of the weekly limit (1 point = 1% of it): one decimal below 10, whole numbers above.
 * 0.04 → "<0.1%", 3.14 → "3.1%", 41.6 → "42%".
 */
export function pts(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (n <= 0) return "0%";
  if (n < 0.1) return "<0.1%";
  if (n < 10) {
    const r = Math.round(n * 10) / 10;
    return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
  }
  return `${Math.round(n)}%`;
}

export function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

/** "just now", "5 min ago", "3h ago", "yesterday", "4 days ago" */
export function relTime(iso) {
  if (!iso) return "never";
  const min = minutesSince(iso);
  if (min < 1) return "just now";
  if (min < 60) return `${Math.floor(min)} min ago`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today at 9:30 PM", "tomorrow at 9:30 PM", "Monday at 9:30 PM", "Oct 21 at 9:30 PM" */
export function whenLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return `today at ${time}`;
  if (sameDay(d, tomorrow)) return `tomorrow at ${time}`;
  const days = (d - now) / 86400000;
  if (days > 0 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

export function shortDate(isoDate) {
  // isoDate "2026-10-14" is a calendar date; parse as local noon to avoid tz shifts.
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function credits(n) {
  if (n === null || n === undefined) return "–";
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n >= 10 ? 0 : 1);
}

export function browserName(info) {
  const raw = String(info || "").toLowerCase();
  if (raw.includes("edge")) return "Edge";
  if (raw.includes("brave")) return "Brave";
  if (raw.includes("arc")) return "Arc";
  if (raw.includes("opera")) return "Opera";
  if (raw.includes("vivaldi")) return "Vivaldi";
  if (raw.includes("chrom")) return "Chrome";
  return info || "";
}

export function osName(info) {
  const raw = String(info || "").toLowerCase();
  if (raw.includes("mac") || raw.includes("darwin")) return "Mac";
  if (raw.includes("win")) return "Windows";
  if (raw.includes("linux")) return "Linux";
  return info || "";
}
