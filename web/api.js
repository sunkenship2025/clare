// Shared API client for the clare web pages.
// - apiUrl comes from window.CLARE (config.js), overridable with ?api=<url> (remembered),
//   ?api=default forgets the override, ?api=mock serves fixtures from dev/mock.js.
// - Every request carries X-Clare-TZ so server-written messages use local time.

const cfg = window.CLARE || {};
const API_KEY = "clare.api";
const TOKEN_KEY = "clare.token";
let memoryToken = null;

function configured(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("__CLARE_");
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: keep going without it */
  }
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const apiUrl = (() => {
  const params = new URLSearchParams(location.search);
  if (params.has("api")) {
    const v = (params.get("api") || "").trim();
    store(API_KEY, v && v !== "default" ? v : null);
  }
  const chosen = read(API_KEY) || (configured(cfg.apiUrl) ? cfg.apiUrl : "http://localhost:8787");
  return chosen.replace(/\/+$/, "");
})();

export const isMock = apiUrl === "mock";

export const webUrl = configured(cfg.webUrl)
  ? cfg.webUrl.replace(/\/+$/, "")
  : location.origin + location.pathname.replace(/\/[^/]*$/, "");

export const releasesUrl = configured(cfg.releasesUrl)
  ? cfg.releasesUrl.replace(/\/+$/, "")
  : isMock
    ? "https://github.com/example/clare/releases/latest/download"
    : "";

export const extensionUrl = configured(cfg.extensionUrl) ? cfg.extensionUrl : "";

// https://github.com/<owner>/<repo>/releases/latest/download -> https://github.com/<owner>/<repo>
export const repoUrl = (() => {
  const m = releasesUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)/);
  return m ? m[1] : "";
})();

export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getToken() {
  return read(TOKEN_KEY) || memoryToken;
}

export function setToken(token) {
  memoryToken = token;
  store(TOKEN_KEY, token);
}

export function clearToken() {
  memoryToken = null;
  store(TOKEN_KEY, null);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY = {
  0: "Can't reach clare right now. Check your internet connection and try again.",
  401: "Your sign-in has expired. Open the dashboard again from the clare extension, or run clare dashboard.",
  403: "That isn't allowed from here.",
  404: "We couldn't find that. It may have been removed.",
  410: "This was removed.",
  429: "Too many tries. Wait a moment and try again.",
  500: "Something went wrong on clare's side. Try again in a minute.",
};

function friendly(status, body) {
  if (body && typeof body.message === "string" && body.message) return body.message;
  return FRIENDLY[status] || FRIENDLY[status >= 500 ? 500 : 0];
}

/**
 * Call the clare API.
 * @param {string} path  e.g. "/me" or "/enroll/abc"
 * @param {{method?: string, body?: object, auth?: boolean, signal?: AbortSignal}} opts
 */
export async function api(path, { method = "GET", body, auth = true, signal } = {}) {
  const token = auth ? getToken() : null;

  if (isMock) {
    const mock = await import("./dev/mock.js");
    const res = await mock.handle({ method, path, body, token });
    if (res.status >= 400) {
      throw new ApiError(res.status, res.data?.error || "error", friendly(res.status, res.data));
    }
    return res.data;
  }

  const headers = { "X-Clare-TZ": timeZone() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", FRIENDLY[0]);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || "error", friendly(res.status, data));
  return data;
}
