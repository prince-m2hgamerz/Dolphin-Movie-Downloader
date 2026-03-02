const { Readable } = require("stream");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function resolveApiBaseUrl() {
  const env = (process.env.VERCEL_ENV || process.env.NODE_ENV || "development").toLowerCase();
  const byEnv = {
    production: process.env.API_BASE_URL_PRODUCTION,
    preview: process.env.API_BASE_URL_PREVIEW,
    development: process.env.API_BASE_URL_DEVELOPMENT,
  };

  const base =
    byEnv[env] ||
    process.env.API_BASE_URL ||
    process.env.EC2_API_BASE_URL ||
    "";

  return String(base || "").replace(/\/+$/, "");
}

function buildTargetUrl(req, baseUrl) {
  const full = String(req.url || "");
  const queryIndex = full.indexOf("?");
  const rawPath = queryIndex >= 0 ? full.slice(0, queryIndex) : full;
  const rawQuery = queryIndex >= 0 ? full.slice(queryIndex) : "";
  const suffix = rawPath.startsWith("/api/") ? rawPath.slice(5) : "";
  return `${baseUrl}/api/${suffix}${rawQuery}`;
}

function buildForwardHeaders(req) {
  const forward = {};
  Object.entries(req.headers || {}).forEach(([key, value]) => {
    if (!key || value === undefined) return;
    if (HOP_BY_HOP_HEADERS.has(String(key).toLowerCase())) return;
    forward[key] = value;
  });
  return forward;
}

module.exports = async (req, res) => {
  const baseUrl = resolveApiBaseUrl();
  if (!baseUrl) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error:
          "Missing API base URL. Set API_BASE_URL or API_BASE_URL_{PRODUCTION|PREVIEW|DEVELOPMENT}.",
      })
    );
    return;
  }

  const target = buildTargetUrl(req, baseUrl);
  const headers = buildForwardHeaders(req);
  const method = String(req.method || "GET").toUpperCase();

  const init = {
    method,
    headers,
    redirect: "manual",
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(target, init);
    res.statusCode = upstream.status;

    upstream.headers.forEach((value, key) => {
      if (!key || HOP_BY_HOP_HEADERS.has(String(key).toLowerCase())) return;
      res.setHeader(key, value);
    });

    if (method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "Upstream API request failed",
        detail: error && error.message ? error.message : "Unknown error",
      })
    );
  }
};
