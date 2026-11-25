// Loads the app from makecomapp.json and runs its requests the way Make does, through a
// transport the test supplies (a fake API checked against openapi.json, or the real API).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTemplate, render, truthy } from "./iml.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

export const manifest = readJson("makecomapp.json");
export const base = readJson(manifest.generalCodeFiles.base);

/** The code files of one component, parsed: { communication, params, ... }. */
export function component(type, id) {
  const meta = manifest.components[type][id];
  if (!meta) throw new Error(`No ${type} ${id} in makecomapp.json`);
  const code = {};
  for (const [codeType, path] of Object.entries(meta.codeFiles)) if (path) code[codeType] = readJson(path);
  return { id, meta, ...code };
}

export const moduleIds = () => Object.keys(manifest.components.module);

/** Joins a request URL onto Base's baseUrl, like Make does for relative URLs. */
function resolveUrl(url) {
  // Make removes the extra slash between a fixed prefix ending in "/" and a path starting with "/".
  if (/^https?:\/\//.test(url)) return url.replace(/^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/\/+/, "$1/");
  return base.baseUrl.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
}

/** Base headers, then the request's: per name (case-insensitive), or replaced by a whole expression. */
function mergeHeaders(baseHeaders, requestHeaders, rawRequestHeaders) {
  const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (typeof rawRequestHeaders === "string") return lower(requestHeaders);
  return { ...lower(baseHeaders), ...lower(requestHeaders) };
}

export class MakeError extends Error {}

/**
 * Runs one request specification (or an array of them) and returns the module output:
 * an array of bundles. `inheritBase` is false for connection communication, which does not
 * inherit Base. `transport(request)` returns `{ statusCode, headers, body }`.
 */
export async function runCommunication(spec, { parameters = {}, connection, payload, webhook, transport, inheritBase = true, sleep = async () => {} }) {
  const requests = Array.isArray(spec) ? spec : [spec];
  let temp = {};
  let bundles = [];
  let data;
  for (const request of requests) {
    let repeats = 0;
    for (;;) {
      ({ bundles, data } = await runRequest(request, { parameters, connection, payload, webhook, temp, transport, inheritBase }));
      temp = { ...temp, ...data.temp };
      const repeat = request.repeat;
      const ctx = { parameters, connection, temp };
      if (!repeat || !truthy(evaluateTemplate(repeat.condition, ctx)) || repeats + 1 >= repeat.limit) break;
      repeats += 1;
      await sleep(repeat.delay);
    }
  }
  return { bundles, temp, data: data.responseData };
}

async function runRequest(request, { parameters, connection, payload, webhook, temp, transport, inheritBase }) {
  const out = [];
  let responseData;
  let responseTemp = {};
  const response = request.response ?? {};
  const limit = response.limit !== undefined ? Number(evaluateTemplate(String(response.limit), { parameters })) : Infinity;
  for (let page = 1; ; page += 1) {
    const pagination = { page };
    const ctx = { parameters, connection, payload, webhook, temp, pagination };
    if (request.condition !== undefined && !truthy(render(request.condition, ctx))) return { bundles: [], data: { temp: {} } };
    const qs = { ...(inheritBase ? render(base.qs ?? {}, ctx) : {}), ...render(request.qs ?? {}, ctx), ...(page > 1 ? render(request.pagination?.qs ?? {}, ctx) : {}) };
    const sent = {
      url: resolveUrl(render(request.url, ctx)),
      method: String(render(request.method ?? "GET", ctx)).toUpperCase(),
      headers: mergeHeaders(inheritBase ? render(base.headers ?? {}, ctx) : {}, render(request.headers ?? {}, ctx), request.headers),
      qs: typeof request.qs === "string" ? render(request.qs, ctx) : qs,
      type: request.type ?? "json",
      body: request.body === undefined ? undefined : render(request.body, ctx),
      sanitize: [...(inheritBase ? base.log?.sanitize ?? [] : []), ...(request.log?.sanitize ?? [])],
    };
    const res = await transport(sent);
    const rctx = { ...ctx, body: res.body, headers: res.headers ?? {}, statusCode: res.statusCode };
    if (res.statusCode >= 400) {
      const error = response.error ?? (inheritBase ? base.response?.error : undefined) ?? {};
      throw new MakeError(error.message ? render(error.message, rctx) : `HTTP ${res.statusCode}`);
    }
    if (response.valid !== undefined) {
      const valid = typeof response.valid === "object" ? response.valid : { condition: response.valid };
      if (!truthy(render(valid.condition, rctx))) throw new MakeError(valid.message ? render(valid.message, rctx) : "Response marked as invalid.");
    }
    responseTemp = { ...responseTemp, ...render(response.temp ?? {}, rctx) };
    if (response.data !== undefined) responseData = render(response.data, rctx);
    if (response.iterate !== undefined) {
      const items = render(response.iterate, rctx) ?? [];
      for (const item of items) {
        if (out.length >= limit) break;
        out.push(response.output === undefined ? item : render(response.output, { ...rctx, item }));
      }
      const more = request.pagination && items.length > 0 && out.length < limit && (request.pagination.condition === undefined || truthy(render(request.pagination.condition, rctx)));
      if (more) continue;
    } else if (response.output !== undefined) {
      out.push(render(response.output, rctx));
    }
    return { bundles: out, data: { temp: responseTemp, responseData } };
  }
}

/** The webhook receiver: whether Make accepts the call, its reply and the bundle it passes on. */
export function receiveWebhook(communication, incoming) {
  const ctx = { body: incoming.body, headers: incoming.headers ?? {}, query: incoming.query ?? {}, method: incoming.method ?? "POST" };
  const respond = render(communication.respond ?? {}, ctx);
  const accepted = communication.condition === undefined || truthy(render(communication.condition, ctx));
  return { accepted, respond, output: accepted ? render(communication.output ?? "{{body}}", ctx) : undefined };
}
