// Live checks against https://api.ampost.io (npm run test:smoke). Not part of npm test.
//
// Without a key: every request the app's components send goes to the real API with a key that
// is not valid. The API answers 401 on routes that exist, 404 on unknown paths and 405 on a
// wrong method, so a 401 proves each path and method. It also checks Base's error message.
//
// With AMPOST_API_KEY: the connection check and the read-only modules run for real, and their
// output is checked against the response schemas. Nothing is created or changed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MakeError, component, manifest, runCommunication } from "./lib/app.mjs";
import { API_ORIGIN, findOperation, schemaErrors, successSchema } from "./lib/openapi.mjs";

const NOT_A_KEY = "amp_smoke_not_a_real_key";
const apiKey = process.env.AMPOST_API_KEY;

/** A transport on fetch. Only Ampost's API is ever called. */
function fetchTransport(log = []) {
  return async (request) => {
    const url = new URL(request.url);
    assert.equal(url.origin, API_ORIGIN, `smoke requests stay on ${API_ORIGIN}`);
    for (const [name, value] of Object.entries(request.qs ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const headers = { ...request.headers };
    let body;
    if (request.body !== undefined) {
      body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      headers["content-type"] ??= "application/json";
    }
    const res = await fetch(url, { method: request.method, headers, body });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    log.push({ request, statusCode: res.status, body: parsed });
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: parsed };
  };
}

const UUID = "3f0c2a8e-6b1d-4c7a-9e52-8d4b1f6a7c30";
// Parameters that render a valid request for each component; values are placeholders.
const PROBES = {
  createPost: { targets: [{ platforms: ["bluesky"] }], text: "smoke", when: "draft" },
  validatePost: { targets: [{ platforms: ["bluesky"] }], text: "smoke", when: "draft" },
  getPost: { postId: UUID },
  publishPost: { postId: UUID },
  retryPost: { postId: UUID },
  deletePost: { postId: UUID },
  unpublishPost: { postId: UUID },
  editPublishedPost: { postId: UUID, text: "smoke" },
  listPosts: { limit: 1 },
  uploadMedia: { fileName: "smoke.jpg", data: Buffer.from("x") },
  listAccounts: { limit: 1 },
  listPlatformSets: { limit: 1 },
  getQueueSlots: { platformSetId: UUID, count: 1 },
  listPostAnalytics: { limit: 1 },
  getAnalyticsOverview: { from: "2026-11-01", to: "2026-11-02" },
  listFollowers: { limit: 1 },
  makeApiCall: { url: "/accounts", method: "GET" },
};

async function probe(spec, options) {
  const log = [];
  let error;
  try {
    await runCommunication(spec, { ...options, transport: fetchTransport(log) });
  } catch (e) {
    error = e;
  }
  return { log, error };
}

// Base's message ends with the error code; the connection (which does not use Base) has its own.
function assertRejectedOnAKnownRoute({ log, error }, message = /^\[401\] .+ \(UNAUTHORIZED\)$/) {
  assert.equal(log.length, 1, "the run stops at the first request");
  const { request, statusCode, body } = log[0];
  const path = new URL(request.url).pathname;
  assert.equal(statusCode, 401, `${request.method} ${path} answered ${statusCode}: ${JSON.stringify(body)}`);
  assert.ok(findOperation(request.method, path)?.operation, `${request.method} ${path} is not in openapi.json`);
  assert.ok(error instanceof MakeError);
  assert.match(error.message, message);
}

describe("every request reaches a real route (no key)", () => {
  for (const [id, parameters] of Object.entries(PROBES)) {
    it(`module ${id}`, async () => {
      assertRejectedOnAKnownRoute(await probe(component("module", id).communication, { parameters, connection: { apiKey: NOT_A_KEY } }));
    });
  }
  for (const id of Object.keys(manifest.components.rpc)) {
    it(`rpc ${id}`, async () => {
      assertRejectedOnAKnownRoute(await probe(component("rpc", id).communication, { connection: { apiKey: NOT_A_KEY } }));
    });
  }
  for (const id of Object.keys(manifest.components.webhook)) {
    const hook = component("webhook", id);
    it(`webhook ${id}: attach and detach`, async () => {
      const connection = { apiKey: NOT_A_KEY };
      assertRejectedOnAKnownRoute(await probe(hook.attach, { parameters: { events: hook.params[0].default }, connection, webhook: { url: "https://hook.eu1.make.com/smoke" } }));
      assertRejectedOnAKnownRoute(await probe(hook.detach, { connection, webhook: { externalHookId: UUID } }));
    });
  }
  for (const id of ["watchPostEvents", "watchAccountEvents"]) {
    it(`trigger ${id}: the enrichment request`, async () => {
      const payload = { type: "x", data: { post: { id: UUID }, account: { id: UUID } } };
      assertRejectedOnAKnownRoute(await probe(component("module", id).communication, { payload, connection: { apiKey: NOT_A_KEY } }));
    });
  }
  it("connection ampost", async () => {
    assertRejectedOnAKnownRoute(await probe(component("connection", "ampost").communication, { parameters: { apiKey: NOT_A_KEY }, inheritBase: false }), /^\[401\] Send a valid API key/);
  });
});

describe("read-only modules with a real key", { skip: !apiKey && "set AMPOST_API_KEY to run" }, () => {
  const connection = { apiKey };
  const run = async (type, id, parameters = {}) => {
    const log = [];
    const spec = component(type, id).communication;
    const result = await runCommunication(spec, { parameters, connection, transport: fetchTransport(log), inheritBase: type !== "connection" });
    for (const { request, statusCode, body } of log) {
      const { operation } = findOperation(request.method, new URL(request.url).pathname);
      const { schema } = successSchema(operation);
      assert.ok(statusCode < 300, `${operation.operationId}: ${statusCode}`);
      assert.deepEqual(schemaErrors(schema, body), [], `${operation.operationId} answered outside its schema`);
    }
    return result.bundles;
  };

  it("the connection accepts the key", async () => {
    await run("connection", "ampost", { apiKey });
  });
  it("platform sets, accounts and their pickers", async () => {
    const sets = await run("module", "listPlatformSets", { limit: 5 });
    assert.ok(sets.length > 0, "the account has a platform set");
    await run("module", "listAccounts", { limit: 5 });
    await run("rpc", "listPlatformSetOptions");
    await run("rpc", "listAccountOptions");
    await run("module", "getQueueSlots", { platformSetId: sets[0].id, count: 3 });
  });
  it("Validate a post (creates nothing)", async () => {
    const [result] = await run("module", "validatePost", { targets: [{ platforms: ["bluesky"] }], text: "Smoke test from make-ampost", when: "now" });
    assert.equal(typeof result.valid, "boolean");
  });
  it("posts and analytics", async () => {
    await run("module", "listPosts", { limit: 3 });
    await run("module", "listPostAnalytics", { limit: 3 });
    await run("module", "listFollowers", { limit: 3 });
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    await run("module", "getAnalyticsOverview", { from: monthAgo, to: today });
  });
});
