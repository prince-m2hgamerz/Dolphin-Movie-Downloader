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
  const env = String(
    process.env.VERCEL_ENV || process.env.NODE_ENV || "development"
  ).toLowerCase();

  const envCandidates = {
    production: [
      process.env.API_BASE_URL_PRODUCTION,
      process.env.PRODUCTION_API_BASE_URL,
      process.env.EC2_API_BASE_URL_PRODUCTION,
    ],
    preview: [
      process.env.API_BASE_URL_PREVIEW,
      process.env.PREVIEW_API_BASE_URL,
      process.env.EC2_API_BASE_URL_PREVIEW,
    ],
    development: [
      process.env.API_BASE_URL_DEVELOPMENT,
      process.env.DEVELOPMENT_API_BASE_URL,
      process.env.EC2_API_BASE_URL_DEVELOPMENT,
    ],
  };

  const commonCandidates = [
    process.env.API_BASE_URL,
    process.env.EC2_API_BASE_URL,
    process.env.EC2_API_URL,
    process.env.UPSTREAM_API_BASE_URL,
    process.env.BACKEND_API_BASE_URL,
  ];

  const pick = (values) => values.find((value) => typeof value === "string" && value.trim());
  const base = pick(envCandidates[env] || []) || pick(commonCandidates) || "";

  return String(base).trim().replace(/\/+$/, "");
}

function parseIncomingPath(req) {
  const raw = String(req.url || "/");
  try {
    const parsed = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(raw, "http://localhost");
    return {
      pathname: parsed.pathname || "/",
      search: parsed.search || "",
    };
  } catch (error) {
    const queryIndex = raw.indexOf("?");
    return {
      pathname: queryIndex >= 0 ? raw.slice(0, queryIndex) : raw,
      search: queryIndex >= 0 ? raw.slice(queryIndex) : "",
    };
  }
}

function buildTargetUrl(req, baseUrl) {
  const { pathname, search } = parseIncomingPath(req);
  const suffix = pathname.replace(/^\/api\/?/, "");
  const normalized = suffix ? `/${suffix}` : "";
  return `${baseUrl}/api${normalized}${search}`;
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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function handleMissingBaseFallback(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const { pathname } = parseIncomingPath(req);

  if (method === "GET" && pathname === "/api/get-config") {
    sendJson(res, 200, {
      downloadPath: "Managed by server (hidden)",
      pathLocked: true,
      proxy: false,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/download-status") {
    sendJson(res, 200, []);
    return true;
  }

  if (method === "GET" && pathname === "/api/downloads") {
    sendJson(res, 200, []);
    return true;
  }

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: false,
      proxy: false,
      error: "missing_api_base_url",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  return false;
}

module.exports = async (req, res) => {
  const baseUrl = resolveApiBaseUrl();
  if (!baseUrl) {
    if (handleMissingBaseFallback(req, res)) return;

    sendJson(res, 503, {
      error:
        "Missing API base URL. Set API_BASE_URL or API_BASE_URL_{PRODUCTION|PREVIEW|DEVELOPMENT}.",
    });
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
    if (handleMissingBaseFallback(req, res)) return;

    sendJson(res, 502, {
      error: "Upstream API request failed",
      detail: error && error.message ? error.message : "Unknown error",
    });
  }
};
