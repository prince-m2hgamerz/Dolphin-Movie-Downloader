const assert = require("assert");
const { loadEnvFile } = require("../lib/env");

process.env.SKIP_RESTORE = "1";
loadEnvFile();

const { createServer, boot, shutdown } = require("../server");

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  return { status: response.status, payload };
}

async function run() {
  await boot();
  const server = createServer();

  const bindHost = process.env.TEST_BIND_HOST || process.env.HOST || "127.0.0.1";
  const requestedPort = Number(process.env.TEST_PORT || 0);
  const listenPort =
    Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 0;

  await new Promise((resolve) => {
    server.listen(listenPort, bindHost, resolve);
  });

  const { port } = server.address();
  const clientHost =
    process.env.TEST_CLIENT_HOST ||
    (bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost);
  const baseUrl = `http://${clientHost}:${port}`;
  const results = [];

  try {
    const healthResponse = await requestJson(baseUrl, "/api/health");
    assert.strictEqual(healthResponse.status, 200);
    assert.ok(healthResponse.payload && healthResponse.payload.ok === true);
    results.push("health: server health endpoint responds");

    const configResponse = await requestJson(baseUrl, "/api/get-config");
    assert.strictEqual(configResponse.status, 200);
    assert.ok(configResponse.payload);
    assert.ok(typeof configResponse.payload.downloadPath === "string");
    results.push("get-config: returns server download path");

    const getMagnetMethodCheck = await requestJson(baseUrl, "/api/get-magnet");
    assert.strictEqual(getMagnetMethodCheck.status, 405);
    results.push("get-magnet: rejects non-POST");

    const passthroughMagnet = "magnet:?xt=urn:btih:testhash";
    const getMagnetPassThrough = await requestJson(baseUrl, "/api/get-magnet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnet: passthroughMagnet }),
    });
    assert.strictEqual(getMagnetPassThrough.status, 200);
    assert.strictEqual(getMagnetPassThrough.payload.magnet, passthroughMagnet);
    results.push("get-magnet: returns provided magnet");

    const searchMissingQuery = await requestJson(baseUrl, "/api/search-movies");
    assert.strictEqual(searchMissingQuery.status, 400);
    results.push("search-movies: validates query parameter");

    const startDownloadInvalid = await requestJson(baseUrl, "/api/start-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(startDownloadInvalid.status, 400);
    results.push("start-download: validates payload");

    const statusResponse = await requestJson(baseUrl, "/api/download-status");
    assert.strictEqual(statusResponse.status, 200);
    assert.ok(Array.isArray(statusResponse.payload));
    results.push("download-status: returns array payload");

    console.log("EC2 API smoke tests passed:");
    results.forEach((line) => console.log(`- ${line}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await shutdown();
  }
}

run()
  .catch((error) => {
    console.error("EC2 API smoke tests failed:");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
