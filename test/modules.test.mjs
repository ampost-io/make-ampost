// Runs every module, RPC, webhook and the connection against a fake Ampost API. The fake checks
// each request against openapi.json (path, method, path and query parameters, headers, body) and
// answers with fixtures that match the response schemas. The module output must equal its
// samples file, so the samples show what Make users really get.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MakeError, component, manifest, receiveWebhook, runCommunication } from "./lib/app.mjs";
import { API_ORIGIN, checkRequest, componentSchema, schemaErrors, spec, successSchema } from "./lib/openapi.mjs";

const API_KEY = "amp_test_0123456789abcdef";
const connection = { apiKey: API_KEY };
const UPLOAD_TOKEN = "Bearer vercel_blob_client_test_token";
const UPLOAD_URL = "https://blob.vercel-storage.com/media/u/launch.mp4";

const sample = (id) => component("module", id).samples;
const page = (data, offset = 0, hasMore = false, total = data.length) => ({
  data,
  pagination: { limit: 100, offset, total, hasMore },
});

const uploadCreated = {
  id: sample("uploadMedia").uploadId,
  status: "pending",
  uploadPageUrl: "https://ampost.io/upload/c0ffee00",
  uploadUrl: UPLOAD_URL,
  method: "PUT",
  headers: {
    authorization: UPLOAD_TOKEN,
    "x-api-version": "11",
    "x-vercel-blob-access": "public",
    "x-add-random-suffix": "1",
    "x-allow-overwrite": "0",
  },
  limits: { maxFiles: 1, maxSizeBytes: 524288000, mimeTypes: ["image/jpeg", "image/png", "video/mp4"] },
  createdAt: "2026-11-20T09:00:00.000Z",
  expiresAt: "2026-11-20T10:00:00.000Z",
};
const uploadStatus = (status) => {
  const s = sample("uploadMedia");
  return {
    id: s.uploadId,
    status,
    files:
      status === "completed"
        ? [{ url: s.url, type: s.type, mimeType: s.mimeType, sizeBytes: s.sizeBytes, width: s.width, height: s.height, durationSeconds: s.durationSeconds }]
        : [],
    createdAt: "2026-11-20T09:00:00.000Z",
    expiresAt: "2026-11-20T10:00:00.000Z",
    completedAt: status === "completed" ? "2026-11-20T09:00:09.000Z" : null,
    error: status === "failed" ? "The file type is not allowed." : null,
  };
};
const webhookCreated = {
  id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  url: "https://hook.eu1.make.com/abc123",
  description: "Make: Watch post events",
  events: ["post.published"],
  secret: "whsec_test_secret",
  secretPreview: "whsec_te…",
  enabled: true,
  disabledReason: null,
  disabledAt: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  lastSuccessAt: null,
  createdAt: "2026-11-20T09:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
};

/** Default answers by operation; a test can override any of them. */
function defaultFixtures() {
  return {
    posts_create: () => sample("createPost"),
    posts_validate: () => sample("validatePost"),
    posts_get: () => sample("getPost"),
    posts_list: () => page([sample("listPosts")]),
    posts_publish: () => sample("publishPost"),
    posts_retry: () => sample("retryPost"),
    posts_delete: () => sample("deletePost"),
    posts_unpublish: () => sample("unpublishPost"),
    posts_edit_published: () => sample("editPublishedPost"),
    media_upload_create: () => uploadCreated,
    media_upload_status: () => uploadStatus("completed"),
    accounts_list: () => page([sample("listAccounts")]),
    accounts_get: () => sample("watchAccountEvents").account,
    platform_sets_list: () => page([sample("listPlatformSets")]),
    queue_slots: () => ({
      platformSetId: sample("getQueueSlots").platformSetId,
      timezone: sample("getQueueSlots").timezone,
      slots: [{ scheduledFor: sample("getQueueSlots").scheduledFor, postId: null }],
    }),
    analytics_posts: () => page([sample("listPostAnalytics")]),
    analytics_overview: () => sample("getAnalyticsOverview"),
    analytics_followers: () => page([sample("listFollowers")]),
    webhooks_create: () => webhookCreated,
    webhooks_delete: () => ({ id: webhookCreated.id, deleted: true }),
    docs_search: () => ({ data: [] }),
  };
}

/** A fake API. `calls` records every request; each answer is checked against the spec. */
function fakeApi(overrides = {}) {
  const fixtures = { ...defaultFixtures(), ...overrides };
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (!request.url.startsWith(API_ORIGIN + "/")) {
      return fixtures.external ? fixtures.external(request) : { statusCode: 404, body: {} };
    }
    const { operation, errors } = checkRequest(request, API_KEY);
    assert.deepEqual(errors, [], `${request.method} ${request.url}: ${errors.join("; ")}`);
    const fixture = fixtures[operation.operationId];
    assert.ok(fixture, `no fixture for ${operation.operationId}`);
    const answer = fixture(request);
    if (answer && answer.statusCode) return answer;
    const { status, schema } = successSchema(operation);
    if (operation.operationId !== "webhooks_delete") {
      assert.deepEqual(schemaErrors(schema, answer), [], `fixture for ${operation.operationId} breaks the response schema`);
    }
    return { statusCode: status, headers: { "content-type": "application/json" }, body: answer };
  };
  return { transport, calls };
}

async function run(id, parameters, overrides) {
  const api = fakeApi(overrides);
  const { communication } = component("module", id);
  const result = await runCommunication(communication, { parameters, connection, transport: api.transport });
  return { ...result, calls: api.calls };
}

/** The top-level output fields must all be in the interface, and the interface must not invent fields. */
function assertInterfaceCovers(id, output, optional = []) {
  const names = component("module", id).interface.map((p) => p.name);
  for (const key of Object.keys(output)) assert.ok(names.includes(key), `${id}: output field ${key} is not in the interface`);
  for (const name of names) assert.ok(name in output || optional.includes(name), `${id}: interface field ${name} is not in the output`);
}

const POST_ID = sample("getPost").id;
const SET_ID = sample("listPlatformSets").id;
const ACCOUNT_ID = sample("listAccounts").id;

describe("post modules", () => {
  const fields = {
    targets: [{ platformSetId: SET_ID, platforms: ["instagram", "linkedin"] }],
    text: "We just shipped scheduled posts from Make.",
    linkUrl: "https://ampost.io/blog/make",
    media: [{ url: "https://media.ampost.io/u/launch.jpg", type: "image", altText: "The Ampost dashboard" }],
  };

  it("Create a post: schedule, with metadata, options and an idempotency key", async () => {
    const { bundles, calls } = await run("createPost", {
      ...fields,
      when: "schedule",
      scheduledFor: "2026-11-24T15:00:00.000Z",
      options: '{"linkedin": {"visibility": "PUBLIC"}}',
      metadata: [{ key: "row", value: "12" }],
      mediaFit: "pad",
      "Idempotency-Key": "sheet-row-12",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.ampost.io/api/posts");
    assert.equal(calls[0].headers["idempotency-key"], "sheet-row-12");
    assert.deepEqual(calls[0].body, {
      ...fields,
      mediaFit: "pad",
      options: { linkedin: { visibility: "PUBLIC" } },
      metadata: { row: "12" },
      scheduledFor: "2026-11-24T15:00:00.000Z",
    });
    assert.deepEqual(bundles, [sample("createPost")]);
    assertInterfaceCovers("createPost", bundles[0]);
  });

  it("Create a post: publish now, queue and draft send only their own flag; no empty idempotency header", async () => {
    const now = await run("createPost", { ...fields, when: "now" });
    assert.equal(now.calls[0].body.publishNow, true);
    assert.equal("useQueue" in now.calls[0].body || "scheduledFor" in now.calls[0].body, false);
    assert.equal("idempotency-key" in now.calls[0].headers, false);

    const queue = await run("createPost", { targets: [{ platforms: ["bluesky"] }], text: "Queued", when: "queue" });
    assert.deepEqual(queue.calls[0].body, { targets: [{ platforms: ["bluesky"] }], text: "Queued", options: {}, useQueue: true });

    const draft = await run("createPost", { targets: [{ platforms: ["bluesky"] }], text: "Draft", when: "draft", scheduledFor: "2026-11-24T15:00:00.000Z" });
    assert.deepEqual(draft.calls[0].body, { targets: [{ platforms: ["bluesky"] }], text: "Draft", options: {} });
  });

  it("Create a post: platform option fields, merged with the JSON fallback; a field set replaces that platform's JSON", async () => {
    const { calls } = await run("createPost", {
      targets: [{ platforms: ["youtube", "tiktok", "telegram"] }],
      text: "Video",
      when: "draft",
      youtube: { title: "My video", privacyStatus: "unlisted", madeForKids: false, tags: ["make", "ampost"] },
      tiktok: { privacyLevel: "SELF_ONLY", consent: true },
      options: '{"youtube": {"title": "ignored"}, "telegram": {"disableNotification": true}}',
    });
    assert.deepEqual(calls[0].body.options, {
      youtube: { title: "My video", privacyStatus: "unlisted", madeForKids: false, tags: ["make", "ampost"] },
      tiktok: { privacyLevel: "SELF_ONLY", consent: true },
      telegram: { disableNotification: true },
    });
    for (const name of ["youtube", "tiktok", "pinterest", "instagram", "facebook", "linkedin"]) assert.equal(name in calls[0].body, false);
  });

  it("Validate a post sends the same body to /api/posts/validate", async () => {
    const { bundles, calls } = await run("validatePost", { ...fields, when: "now" });
    assert.equal(calls[0].url, "https://api.ampost.io/api/posts/validate");
    assert.deepEqual(calls[0].body, { ...fields, options: {}, publishNow: true });
    assert.deepEqual(bundles, [sample("validatePost")]);
    assertInterfaceCovers("validatePost", bundles[0]);
  });

  it("Get a post", async () => {
    const { bundles, calls } = await run("getPost", { postId: POST_ID });
    assert.equal(calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}`);
    assert.deepEqual(bundles, [sample("getPost")]);
    assertInterfaceCovers("getPost", bundles[0]);
  });

  it("Get a post encodes the ID, so a mapped value can't change the path", async () => {
    const api = fakeApi();
    const { communication } = component("module", "getPost");
    await assert.rejects(
      runCommunication(communication, { parameters: { postId: "../accounts" }, connection, transport: api.transport }),
      /path postId/,
    );
    assert.equal(api.calls[0].url, "https://api.ampost.io/api/posts/..%2Faccounts");
  });

  it("Search posts: filters go to the query string and pages are read until the limit", async () => {
    const many = Array.from({ length: 100 }, () => sample("listPosts"));
    const { bundles, calls } = await run(
      "listPosts",
      { status: "published", platform: "instagram", platformSetId: SET_ID, search: "Make", limit: 150 },
      { posts_list: (req) => page(many, Number(req.qs.offset ?? 0), true, 300) },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].qs, { status: "published", platform: "instagram", platformSetId: SET_ID, search: "Make", limit: 100 });
    assert.equal(calls[1].qs.offset, 100);
    assert.equal(bundles.length, 150);
    assert.deepEqual(bundles[0], sample("listPosts"));
    assertInterfaceCovers("listPosts", bundles[0]);
  });

  it("Search posts stops when the API has no more", async () => {
    const { bundles, calls } = await run("listPosts", { limit: 10 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].qs, { limit: 100 });
    assert.equal(bundles.length, 1);
  });

  it("Publish a post now", async () => {
    const { bundles, calls } = await run("publishPost", { postId: POST_ID, "Idempotency-Key": "approve-1" });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}/publish`);
    assert.equal(calls[0].headers["idempotency-key"], "approve-1");
    assert.deepEqual(calls[0].body, {});
    assert.deepEqual(bundles, [sample("publishPost")]);
    assertInterfaceCovers("publishPost", bundles[0]);
  });

  it("Retry a failed post: all failed accounts, or the chosen ones", async () => {
    const all = await run("retryPost", { postId: POST_ID });
    assert.equal(all.calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}/retry`);
    assert.deepEqual(all.calls[0].body, {});
    const some = await run("retryPost", { postId: POST_ID, accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.calls[0].body, { accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.bundles, [sample("retryPost")]);
    assertInterfaceCovers("retryPost", some.bundles[0]);
  });

  it("Delete a post", async () => {
    const { bundles, calls } = await run("deletePost", { postId: POST_ID });
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}`);
    assert.equal(calls[0].body, undefined);
    assert.deepEqual(bundles, [sample("deletePost")]);
  });

  it("Unpublish a post: every published account, or the chosen ones", async () => {
    const all = await run("unpublishPost", { postId: POST_ID });
    assert.equal(all.calls[0].method, "POST");
    assert.equal(all.calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}/unpublish`);
    assert.deepEqual(all.calls[0].body, {});
    const some = await run("unpublishPost", { postId: POST_ID, accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.calls[0].body, { accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.bundles, [sample("unpublishPost")]);
    assertInterfaceCovers("unpublishPost", some.bundles[0]);
  });

  it("Edit a published post: the new text, on every published account or the chosen ones", async () => {
    const all = await run("editPublishedPost", { postId: POST_ID, text: "Fixed" });
    assert.equal(all.calls[0].method, "POST");
    assert.equal(all.calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}/edit-published`);
    assert.deepEqual(all.calls[0].body, { text: "Fixed" });
    const some = await run("editPublishedPost", { postId: POST_ID, text: "Fixed", accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.calls[0].body, { text: "Fixed", accountIds: [ACCOUNT_ID] });
    assert.deepEqual(some.bundles, [sample("editPublishedPost")]);
    assertInterfaceCovers("editPublishedPost", some.bundles[0]);
  });

  it("API errors show the message and code from the error body", async () => {
    await assert.rejects(
      run("getPost", { postId: POST_ID }, {
        posts_get: () => ({ statusCode: 404, body: { error: { code: "POST_NOT_FOUND", message: "No post with this id.", details: null } } }),
      }),
      (error) => error instanceof MakeError && error.message === "[404] No post with this id. (POST_NOT_FOUND)",
    );
    await assert.rejects(
      run("getPost", { postId: POST_ID }, { posts_get: () => ({ statusCode: 502, body: "Bad gateway" }) }),
      (error) => error.message === "[502] Ampost API error",
    );
  });
});

describe("Upload a media file", () => {
  const parameters = { fileName: "launch.mp4", data: Buffer.from("fake video bytes") };

  it("creates an upload, PUTs the bytes with the upload token only, and waits until it completes", async () => {
    let polls = 0;
    const { bundles, calls } = await run("uploadMedia", parameters, {
      media_upload_status: () => uploadStatus(++polls < 3 ? "pending" : "completed"),
      external: () => ({ statusCode: 200, body: { url: UPLOAD_URL } }),
    });
    assert.deepEqual(calls[0].body, { fileName: "launch.mp4" });
    const put = calls[1];
    assert.equal(put.method, "PUT");
    assert.equal(put.url, UPLOAD_URL);
    assert.equal(put.type, "binary");
    assert.equal(put.body, parameters.data);
    assert.deepEqual(put.headers, uploadCreated.headers);
    assert.ok(!JSON.stringify(put).includes(API_KEY), "the Ampost API key must not reach the storage host");
    assert.ok(put.sanitize.includes("request.headers.authorization"));
    assert.equal(calls.length, 2 + 3);
    for (const poll of calls.slice(2)) assert.equal(poll.url, `https://api.ampost.io/api/media/uploads/${uploadCreated.id}`);
    assert.deepEqual(bundles, [sample("uploadMedia")]);
    assertInterfaceCovers("uploadMedia", bundles[0]);
  });

  it("stops polling after the repeat limit and returns the pending upload", async () => {
    const { bundles, calls } = await run("uploadMedia", parameters, {
      media_upload_status: () => uploadStatus("pending"),
      external: () => ({ statusCode: 200, body: {} }),
    });
    const { repeat } = component("module", "uploadMedia").communication[2];
    assert.equal(calls.length, 2 + repeat.limit);
    assert.ok(repeat.delay * (repeat.limit - 1) < 40_000, "polling must end inside Make's 40 s module timeout");
    assert.equal(bundles[0].status, "pending");
    assert.equal(bundles[0].url, undefined);
  });

  it("fails with the API's reason when the upload fails", async () => {
    await assert.rejects(
      run("uploadMedia", parameters, {
        media_upload_status: () => uploadStatus("failed"),
        external: () => ({ statusCode: 200, body: {} }),
      }),
      (error) => error instanceof MakeError && error.message === "The upload failed: The file type is not allowed.",
    );
  });
});

describe("account, queue and analytics modules", () => {
  it("List accounts", async () => {
    const { bundles, calls } = await run("listAccounts", { platform: "instagram", platformSetId: SET_ID, status: "all", limit: 10 });
    assert.deepEqual(calls[0].qs, { platform: "instagram", platformSetId: SET_ID, status: "all", limit: 100 });
    assert.deepEqual(bundles, [sample("listAccounts")]);
    assertInterfaceCovers("listAccounts", bundles[0]);
  });

  it("List platform sets", async () => {
    const { bundles, calls } = await run("listPlatformSets", { limit: 10 });
    assert.equal(calls[0].url, "https://api.ampost.io/api/platform-sets");
    assert.deepEqual(bundles, [sample("listPlatformSets")]);
    assertInterfaceCovers("listPlatformSets", bundles[0]);
  });

  it("List queue slots: one bundle per slot", async () => {
    const { bundles, calls } = await run("getQueueSlots", { platformSetId: SET_ID, count: 5, filter: "free" });
    assert.equal(calls[0].url, `https://api.ampost.io/api/platform-sets/${SET_ID}/queue/slots`);
    assert.deepEqual(calls[0].qs, { count: 5, filter: "free" });
    assert.deepEqual(bundles, [sample("getQueueSlots")]);
    assertInterfaceCovers("getQueueSlots", bundles[0]);
  });

  it("List post analytics", async () => {
    const { bundles, calls } = await run("listPostAnalytics", { postId: POST_ID, accountId: ACCOUNT_ID, limit: 10 });
    assert.deepEqual(calls[0].qs, { postId: POST_ID, accountId: ACCOUNT_ID, limit: 100 });
    assert.deepEqual(bundles, [sample("listPostAnalytics")]);
    assertInterfaceCovers("listPostAnalytics", bundles[0]);
  });

  it("Get an analytics overview", async () => {
    const { bundles, calls } = await run("getAnalyticsOverview", { from: "2026-10-22", to: "2026-11-20", platform: "instagram" });
    assert.deepEqual(calls[0].qs, { from: "2026-10-22", to: "2026-11-20", platform: "instagram" });
    assert.deepEqual(bundles, [sample("getAnalyticsOverview")]);
    assertInterfaceCovers("getAnalyticsOverview", bundles[0]);
  });

  it("List follower counts", async () => {
    const { bundles, calls } = await run("listFollowers", { from: "2026-11-19", to: "2026-11-20", limit: 10 });
    assert.deepEqual(calls[0].qs, { from: "2026-11-19", to: "2026-11-20", limit: 100 });
    assert.deepEqual(bundles, [sample("listFollowers")]);
    assertInterfaceCovers("listFollowers", bundles[0]);
  });
});

describe("review rules (Make #2380383)", () => {
  it("Limit is optional and defaults to 10", async () => {
    const many = Array.from({ length: 100 }, () => sample("listPosts"));
    for (const id of ["listPosts", "listAccounts", "listPlatformSets", "listPostAnalytics", "listFollowers"]) {
      const limit = component("module", id).mappableParams.find((p) => p.name === "limit");
      assert.equal(limit.required, undefined, id);
      assert.equal(limit.default, 10, id);
    }
    const { bundles } = await run("listPosts", {}, { posts_list: (req) => page(many, Number(req.qs.offset ?? 0), true, 300) });
    assert.equal(bundles.length, 10);
  });

  it("List queue slots stops at Count", async () => {
    const slots = Array.from({ length: 8 }, (_, i) => ({ scheduledFor: `2026-11-2${i}T09:00:00.000Z`, postId: null }));
    const { bundles } = await run("getQueueSlots", { platformSetId: SET_ID, count: 3 }, {
      queue_slots: () => ({ platformSetId: SET_ID, timezone: "Europe/Warsaw", slots }),
    });
    assert.equal(bundles.length, 3);
  });

  it("dates inside arrays are typed text (parsing them needs custom IML functions)", () => {
    const walk = (fields, inArray, path) => {
      for (const f of fields ?? []) {
        if (inArray) assert.notEqual(f.type, "date", `${path}.${f.name}`);
        if (f.type === "collection") walk(f.spec, inArray, `${path}.${f.name}`);
        if (f.type === "array") walk(Array.isArray(f.spec) ? f.spec : f.spec?.spec, true, `${path}.${f.name}[]`);
      }
    };
    for (const id of Object.keys(manifest.components.module)) walk(component("module", id).interface, false, id);
  });

  it("every post ID field is the post picker", () => {
    for (const id of ["getPost", "publishPost", "retryPost", "deletePost", "unpublishPost", "editPublishedPost", "listPostAnalytics"]) {
      const field = component("module", id).mappableParams.find((p) => p.name === "postId");
      assert.equal(field.type, "select", id);
      assert.equal(field.options, "rpc://listPostOptions", id);
      assert.equal(field.mode, "edit", id);
    }
  });

  it("the post picker shows the start of the text and the status, and lists at most 300", async () => {
    const long = { ...sample("listPosts"), text: "x".repeat(200), status: "draft" };
    const empty = { ...sample("listPosts"), text: "", status: "failed" };
    const api = fakeApi({ posts_list: () => page([long, empty]) });
    const rpc = component("rpc", "listPostOptions").communication;
    const { bundles } = await runCommunication(rpc, { connection, transport: api.transport });
    assert.deepEqual(bundles, [
      { label: `${"x".repeat(60)} (draft)`, value: POST_ID },
      { label: "(no text) (failed)", value: POST_ID },
    ]);
    for (const id of ["listPostOptions", "listAccountOptions", "listPlatformSetOptions"]) {
      assert.equal(component("rpc", id).communication.response.limit, 300, id);
    }
  });
});

describe("Make an API call", () => {
  const call = (parameters) => run("makeApiCall", parameters);

  it("calls a relative path on api.ampost.io with the connection's key", async () => {
    const { bundles, calls } = await call({ url: "/platform-sets", method: "GET", qs: [{ key: "limit", value: "10" }] });
    assert.equal(calls[0].url, "https://api.ampost.io/api/platform-sets");
    assert.deepEqual(calls[0].qs, { limit: "10" });
    assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(Object.keys(bundles[0]).sort(), ["body", "headers", "statusCode"]);
    assertInterfaceCovers("makeApiCall", bundles[0]);
  });

  it("sends a JSON text body and keeps the key when headers are added", async () => {
    const body = JSON.stringify({ targets: [{ platforms: ["bluesky"] }], text: "Hi" });
    const { calls } = await call({ url: "/posts", method: "POST", body, headers: [{ key: "Content-Type", value: "application/json" }] });
    assert.equal(calls[0].body, body);
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
  });

  it("can't send the key to another host", async () => {
    const api = fakeApi({ external: () => ({ statusCode: 200, body: {} }) });
    const { communication } = component("module", "makeApiCall");
    for (const url of ["@evil.example/x", "//evil.example/x", "https://evil.example/x", ".evil.example/x"]) {
      await runCommunication(communication, { parameters: { url, method: "GET" }, connection, transport: api.transport }).catch(() => {});
    }
    for (const sent of api.calls) assert.equal(new URL(sent.url).host, "api.ampost.io", sent.url);
  });
});

describe("connection, RPCs and Base", () => {
  it("the connection checks the key with docs search, without Base", async () => {
    const { communication } = component("connection", "ampost");
    const api = fakeApi();
    await runCommunication(communication, { parameters: { apiKey: API_KEY }, transport: api.transport, inheritBase: false });
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].url, "https://api.ampost.io/api/docs/search");
    assert.deepEqual(communication.log.sanitize, ["request.headers.authorization"]);
  });

  it("the connection reports a rejected key", async () => {
    const { communication } = component("connection", "ampost");
    const api = fakeApi({
      docs_search: () => ({ statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Send a valid API key as a Bearer token, or sign in.", details: null } } }),
    });
    await assert.rejects(
      runCommunication(communication, { parameters: { apiKey: API_KEY }, transport: api.transport, inheritBase: false }),
      (error) => error instanceof MakeError && error.message.startsWith("[401] Send a valid API key"),
    );
  });

  it("the platform set picker", async () => {
    const api = fakeApi();
    const { bundles } = await runCommunication(component("rpc", "listPlatformSetOptions").communication, { connection, transport: api.transport });
    assert.deepEqual(bundles, [{ label: "Default (default)", value: SET_ID }]);
  });

  it("the account picker, with the platform account ID when there is no username", async () => {
    const noName = { ...sample("listAccounts"), username: null };
    const api = fakeApi({ accounts_list: () => page([sample("listAccounts"), noName]) });
    const { bundles } = await runCommunication(component("rpc", "listAccountOptions").communication, { connection, transport: api.transport });
    assert.deepEqual(bundles, [
      { label: "ampost.io (instagram)", value: ACCOUNT_ID },
      { label: `${noName.platformAccountId} (instagram)`, value: ACCOUNT_ID },
    ]);
  });
});

describe("webhooks and instant triggers", () => {
  for (const [webhookId, triggerId, eventPrefix] of [
    ["postEvents", "watchPostEvents", "post."],
    ["accountEvents", "watchAccountEvents", "account."],
  ]) {
    it(`${webhookId}: attach registers Make's URL for the chosen events; detach deletes it`, async () => {
      const hook = component("webhook", webhookId);
      const events = hook.params[0].options.map((o) => o.value);
      assert.ok(events.every((e) => e.startsWith(eventPrefix)));
      const api = fakeApi();
      const attached = await runCommunication(hook.attach, {
        parameters: { events: hook.params[0].default },
        connection,
        webhook: { url: "https://hook.eu1.make.com/abc123" },
        transport: api.transport,
      });
      assert.deepEqual(api.calls[0].body, {
        url: "https://hook.eu1.make.com/abc123",
        events: hook.params[0].default,
        description: `Make: ${manifest.components.module[triggerId].label}`,
      });
      assert.deepEqual(attached.data, { externalHookId: webhookCreated.id });
      assert.ok(api.calls[0].sanitize.includes("response.body.secret"), "the webhook secret must not show in logs");

      await runCommunication(hook.detach, { connection, webhook: attached.data, transport: api.transport });
      assert.equal(api.calls[1].method, "DELETE");
      assert.equal(api.calls[1].url, `https://api.ampost.io/api/webhooks/endpoints/${webhookCreated.id}`);
    });

    it(`${webhookId}: the test event is acknowledged but starts no scenario`, () => {
      const { communication } = component("webhook", webhookId);
      const test = receiveWebhook(communication, { body: { id: "evt_test", type: "webhook.test", createdAt: "2026-11-20T09:00:00.000Z", data: {} } });
      assert.equal(test.accepted, false);
      assert.equal(test.respond.status, 200);
    });
  }

  it("the webhooks offer every post and account event of the API", () => {
    const offered = ["postEvents", "accountEvents"].flatMap((id) => component("webhook", id).params[0].options.map((o) => o.value));
    const apiEvents = spec.components.schemas.CreateWebhookRequest.properties.events.items.enum;
    assert.deepEqual([...offered].sort(), apiEvents.filter((e) => e.startsWith("post.") || e.startsWith("account.")).sort());
  });

  it("Watch post events re-reads the post with the user's key and passes on the event", async () => {
    const event = {
      id: "evt_9b2f6c1d4e",
      type: "post.published",
      createdAt: "2026-11-20T09:00:05.000Z",
      data: { post: { ...sample("getPost"), text: "stale copy from the payload" } },
    };
    assert.deepEqual(schemaErrors(componentSchema("WebhookEvent"), event), []);
    const received = receiveWebhook(component("webhook", "postEvents").communication, { body: event });
    assert.equal(received.accepted, true);
    const api = fakeApi();
    const { bundles } = await runCommunication(component("module", "watchPostEvents").communication, {
      payload: received.output,
      connection,
      transport: api.transport,
    });
    assert.equal(api.calls[0].url, `https://api.ampost.io/api/posts/${POST_ID}`);
    // No platform post on post.* events: the collection comes out empty.
    const { platformPost, ...rest } = bundles[0];
    assert.deepEqual(platformPost, {});
    assert.deepEqual(rest, sample("watchPostEvents"));
    assertInterfaceCovers("watchPostEvents", bundles[0]);
  });

  it("Watch post events passes on the platform post of post.platform.* events", async () => {
    const platformPost = sample("getPost").platformPosts[0];
    const event = { id: "evt_1", type: "post.platform.published", createdAt: "2026-11-20T09:00:05.000Z", data: { post: sample("getPost"), platformPost } };
    const api = fakeApi();
    const { bundles } = await runCommunication(component("module", "watchPostEvents").communication, {
      payload: receiveWebhook(component("webhook", "postEvents").communication, { body: event }).output,
      connection,
      transport: api.transport,
    });
    assert.deepEqual(bundles[0].platformPost, platformPost);
  });

  it("Watch account events re-reads the account", async () => {
    const account = sample("watchAccountEvents").account;
    const event = { id: "evt_4a7c0e2b91", type: "account.needs_reconnect", createdAt: "2026-11-20T09:00:05.000Z", data: { account } };
    const api = fakeApi();
    const { bundles } = await runCommunication(component("module", "watchAccountEvents").communication, {
      payload: receiveWebhook(component("webhook", "accountEvents").communication, { body: event }).output,
      connection,
      transport: api.transport,
    });
    assert.equal(api.calls[0].url, `https://api.ampost.io/api/accounts/${account.id}`);
    assert.deepEqual(bundles, [sample("watchAccountEvents")]);
    assertInterfaceCovers("watchAccountEvents", bundles[0]);
  });
});
