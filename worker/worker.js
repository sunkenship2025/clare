// clare API relay: forwards every request, unchanged, to the Supabase Edge Function.
// Some ISPs block *.supabase.co (e.g. ACT, Jio, Airtel in India); a workers.dev address
// gets through. Set TARGET to https://<project>.supabase.co/functions/v1/api.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const target = env.TARGET.replace(/\/+$/, "") + url.pathname.replace(/^\/+(?=.)/, "/") + url.search;
    const headers = new Headers(req.headers);
    headers.delete("host");
    const ip = req.headers.get("cf-connecting-ip");
    if (ip) headers.set("x-forwarded-for", ip);
    return fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  },
};
