// Checks requests and responses against the openapi.json snapshot of the Ampost API.

import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readJson } from "./app.mjs";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

export const spec = readJson("openapi.json");
export const API_ORIGIN = spec.servers[0].url;

/** Points local `#/components/...` refs at the registered components document. */
function relink(schema) {
  return JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/'));
}

function makeAjv(options = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, ...options });
  addFormats(ajv);
  ajv.addSchema({ $id: "openapi", components: relink(spec.components) });
  return ajv;
}
const ajv = makeAjv();
// Query and path values arrive as text.
const paramAjv = makeAjv({ coerceTypes: true });

const compiled = new Map();
function validator(schema, coerce = false) {
  const key = (coerce ? "c:" : "") + JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, (coerce ? paramAjv : ajv).compile(relink(schema)));
  return compiled.get(key);
}

/** Validates a value against a schema; returns a list of error strings (empty when valid). */
export function schemaErrors(schema, value, coerce = false) {
  const validate = validator(schema, coerce);
  const copy = structuredClone(value);
  return validate(copy) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`);
}

export const componentSchema = (name) => ({ $ref: `#/components/schemas/${name}` });

const routes = Object.entries(spec.paths).map(([template, item]) => {
  const names = [];
  const pattern = template.replace(/\{([^}]+)\}/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  return { template, item, names, regex: new RegExp(`^${pattern}$`), literal: names.length === 0 };
});

/** The operation a path and method hit, with its path parameters; literal paths win. */
export function findOperation(method, path) {
  const candidates = routes.filter((r) => r.regex.test(path)).sort((a, b) => Number(b.literal) - Number(a.literal));
  const route = candidates[0];
  if (!route) return null;
  const operation = route.item[method.toLowerCase()];
  if (!operation) return { route, operation: null };
  const match = route.regex.exec(path);
  const pathParams = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
  return { route, operation, pathParams };
}

/**
 * Checks one request a module sends to the Ampost API. Returns { operation, errors }.
 * `apiKey` is the key the connection holds: every API request must carry it.
 */
export function checkRequest(request, apiKey) {
  const errors = [];
  const url = new URL(request.url);
  if (url.origin !== API_ORIGIN) return { operation: null, errors: [`${request.url} is not on ${API_ORIGIN}`] };
  if (url.search) errors.push(`query in the URL instead of qs: ${url.search}`);
  const found = findOperation(request.method, url.pathname);
  if (!found) return { operation: null, errors: [`No API path matches ${url.pathname}`] };
  if (!found.operation) return { operation: null, errors: [`${request.method} is not allowed on ${found.route.template}`] };
  const { operation, pathParams } = found;
  const params = [...(found.route.item.parameters ?? []), ...(operation.parameters ?? [])];

  for (const param of params.filter((p) => p.in === "path")) {
    for (const e of schemaErrors(param.schema, pathParams[param.name], true)) errors.push(`path ${param.name}: ${e}`);
  }
  const query = params.filter((p) => p.in === "query");
  for (const [name, value] of Object.entries(request.qs ?? {})) {
    const param = query.find((p) => p.name === name);
    if (!param) errors.push(`unknown query parameter ${name}`);
    else for (const e of schemaErrors(param.schema, String(value), true)) errors.push(`query ${name}: ${e}`);
  }
  for (const param of query.filter((p) => p.required)) {
    if (!(param.name in (request.qs ?? {}))) errors.push(`missing required query parameter ${param.name}`);
  }

  const headers = request.headers ?? {};
  if (headers.authorization !== `Bearer ${apiKey}`) errors.push(`authorization header is ${JSON.stringify(headers.authorization)}`);
  if (!request.sanitize?.includes("request.headers.authorization")) errors.push("the authorization header is not sanitized in logs");
  for (const param of params.filter((p) => p.in === "header")) {
    const value = headers[param.name.toLowerCase()];
    if (value !== undefined) for (const e of schemaErrors(param.schema, value)) errors.push(`header ${param.name}: ${e}`);
  }
  for (const name of Object.keys(headers)) {
    if (name !== "authorization" && name !== "content-type" && !params.some((p) => p.in === "header" && p.name.toLowerCase() === name)) {
      errors.push(`header ${name} is not an API parameter`);
    }
  }

  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  let body = request.body;
  if (request.type === "text" && typeof body === "string") {
    try {
      body = body.trim() ? JSON.parse(body) : undefined;
    } catch {
      errors.push("the text body is not JSON");
    }
  }
  const isEmptyObject = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  if (body !== undefined) {
    // The API reads an empty JSON object like no body.
    if (!bodySchema && !isEmptyObject) errors.push(`${operation.operationId} takes no JSON body`);
    else if (bodySchema) for (const e of schemaErrors(bodySchema, body)) errors.push(`body ${e}`);
  } else if (operation.requestBody?.required) {
    errors.push(`${operation.operationId} needs a body`);
  }
  return { operation, errors };
}

/** The JSON schema of an operation's success response. */
export function successSchema(operation) {
  const status = Object.keys(operation.responses).find((s) => /^2/.test(s));
  return { status: Number(status), schema: operation.responses[status].content?.["application/json"]?.schema };
}
