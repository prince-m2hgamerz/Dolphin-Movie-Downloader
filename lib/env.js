const fs = require("fs");
const path = require("path");

let hasLoadedEnv = false;

function stripWrappingQuotes(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;

  const eqIndex = normalized.indexOf("=");
  if (eqIndex <= 0) return null;

  const key = normalized.slice(0, eqIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const rawValue = normalized.slice(eqIndex + 1);
  const value = stripWrappingQuotes(rawValue)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");

  return { key, value };
}

function loadEnvFromFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return;
    if (process.env[parsed.key] !== undefined) return;
    process.env[parsed.key] = parsed.value;
  });
}

function loadEnvFile() {
  if (hasLoadedEnv) return;

  const cwd = process.cwd();
  const candidates = [
    process.env.ENV_FILE ? path.resolve(cwd, process.env.ENV_FILE) : "",
    path.resolve(cwd, ".env"),
    path.resolve(cwd, ".env.local"),
  ].filter(Boolean);

  candidates.forEach((candidate) => {
    if (!fs.existsSync(candidate)) return;
    loadEnvFromFile(candidate);
  });

  hasLoadedEnv = true;
}

function readNumberEnv(name, defaultValue) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return value;
}

function readStringEnv(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  return trimmed || defaultValue;
}

function getRuntimeConfig() {
  loadEnvFile();

  return {
    PORT: readNumberEnv("PORT", 80),
    HOST: readStringEnv("HOST", "0.0.0.0"),
    PUBLIC_BASE_URL: readStringEnv("PUBLIC_BASE_URL", ""),
  };
}

module.exports = {
  getRuntimeConfig,
  loadEnvFile,
};
