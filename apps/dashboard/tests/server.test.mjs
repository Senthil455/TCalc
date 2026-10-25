import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import path from "node:path";
import { createDashboardServer } from "../src/server.mjs";

test("stores only authenticated versioned reports", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, token: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/reports`;
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ schemaVersion: "1.0.0", title: "Incomplete", summary: {} }) })).status, 400);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(report()),
    });
    assert.equal(response.status, 201);
    assert.equal((await (await fetch(url, { headers: { authorization: "Bearer secret" } })).json()).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("preserves UTF-8 split across request chunks", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, token: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const payload = Buffer.from(JSON.stringify(report("Café")));
    const split = payload.indexOf(Buffer.from("é")) + 1;
    const stored = await postChunks(port, payload.subarray(0, split), payload.subarray(split));
    assert.equal(stored.status, 201);
    const saved = await (await fetch(`http://127.0.0.1:${port}/api/reports/${stored.body.id}`, { headers: { authorization: "Bearer secret" } })).json();
    assert.equal(saved.title, "Café");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("denies unauthenticated reads and allows authenticated ones", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, token: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/reports`;
  const auth = { authorization: "Bearer secret" };
  try {
    const created = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(report("Private")) });
    const { id } = await created.json();

    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(`${url}/${id}`)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${url}/${id}`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const list = await fetch(url, { headers: auth });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).length, 1);
    const detail = await fetch(`${url}/${id}`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).title, "Private");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("does not leak reports when no token is configured", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/reports`;
  try {
    assert.equal((await fetch(url)).status, 503);
    assert.equal((await fetch(`${url}/anything`)).status, 503);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("keeps reports closed when public read is enabled without a token", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, publicRead: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/reports`;
  try {
    // Opting into public reads must not re-open access once the token is removed.
    assert.equal((await fetch(url)).status, 503);
    assert.equal((await fetch(`${url}/anything`)).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("exchanges the token for a read-only session cookie", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, token: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${base}/api/reports`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(report()) });

    assert.equal((await fetch(`${base}/api/session`, { method: "POST", body: JSON.stringify({ token: "wrong" }) })).status, 401);

    const session = await fetch(`${base}/api/session`, { method: "POST", body: JSON.stringify({ token: "secret" }) });
    assert.equal(session.status, 200);
    const setCookie = session.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];

    assert.equal((await fetch(`${base}/api/reports`, { headers: { cookie } })).status, 200);

    // The cookie must not authorize writes, or a cross-site page could forge uploads.
    assert.equal((await fetch(`${base}/api/reports`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(report()) })).status, 401);

    await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie } });
    assert.equal((await fetch(`${base}/api/reports`, { headers: { cookie } })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("allows unauthenticated reads only when public read is opted into", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const server = createDashboardServer({ dataDir, token: "secret", publicRead: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/reports`;
  try {
    const created = await fetch(url, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(report("Public")) });
    const { id } = await created.json();

    assert.equal((await fetch(url)).status, 200);
    const detail = await fetch(`${url}/${id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).title, "Public");

    // Public reads must never imply public writes.
    assert.equal((await fetch(url, { method: "POST", body: JSON.stringify(report()) })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("serves normal static files and internal symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const publicDir = path.join(root, "public");
  const server = createDashboardServer({ dataDir: path.join(root, "data"), token: "secret", publicDir });
  await mkdir(path.join(publicDir, "pages"), { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "<h1>Home</h1>");
  await writeFile(path.join(publicDir, "pages", "about.html"), "<h1>About</h1>");
  await symlink(path.join(publicDir, "pages", "about.html"), path.join(publicDir, "alias.html"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await home.text(), "<h1>Home</h1>");

    const about = await fetch(`http://127.0.0.1:${port}/pages/about.html`);
    assert.equal(about.status, 200);
    assert.equal(await about.text(), "<h1>About</h1>");

    const alias = await fetch(`http://127.0.0.1:${port}/alias.html`);
    assert.equal(alias.status, 200);
    assert.equal(await alias.text(), "<h1>About</h1>");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a file symlink that escapes the public directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const publicDir = path.join(root, "public");
  const outside = path.join(root, "outside");
  const server = createDashboardServer({ dataDir: path.join(root, "data"), token: "secret", publicDir });
  await mkdir(publicDir);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  await symlink(path.join(outside, "secret.txt"), path.join(publicDir, "leak.txt"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/leak.txt`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), JSON.stringify({ error: "Not found" }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a directory symlink that escapes the public directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tcalc-dashboard-"));
  const publicDir = path.join(root, "public");
  const outside = path.join(root, "outside");
  const server = createDashboardServer({ dataDir: path.join(root, "data"), token: "secret", publicDir });
  await mkdir(publicDir);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  await symlink(outside, path.join(publicDir, "leakdir"), process.platform === "win32" ? "junction" : "dir");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/leakdir/secret.txt`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/leakdir/`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function report(title = "Report") {
  return {
    schemaVersion: "1.0.0", title, generatedAt: "2026-07-19", workspacePath: "/workspace", goal: "debug",
    summary: { totalFiles: 1, includedFiles: 1, excludedFiles: 0, totalEstimatedTokens: 10, includedTokens: 10 },
    topTokenConsumers: [], topFolders: [], languages: [], recommendations: null,
    warnings: [], assumptions: [], optimizationChecklist: [],
  };
}

function postChunks(port, ...chunks) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/reports", method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
