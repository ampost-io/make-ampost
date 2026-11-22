// The scenario blueprints in templates/: built from scripts/templates.mjs, free of keys, mapping
// only earlier modules, and sending requests the Ampost API accepts (HTTP version: route, headers
// and body against openapi.json; app version: the mapper run through the app's own module).

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { APP, SCENARIOS, blueprints, serialize } from "../scripts/templates.mjs";
import { ROOT, component, manifest, runCommunication } from "./lib/app.mjs";
import { checkRequest, findOperation, schemaErrors } from "./lib/openapi.mjs";

// Modules of other Make apps the templates use, with the version Make's current blueprints use.
const KNOWN_MODULES = {
  "gateway:CustomWebHook": 1,
  "gateway:WebhookRespond": 1,
  "http:ActionSendData": 3,
  "json:TransformToJSON": 1,
  "rss:TriggerNewArticle": 4,
  "google-sheets:watchRows": 2,
  "google-sheets:updateRow": 2,
  "openai-gpt-3:CreateCompletion": 1,
  "google-email:ActionSendEmail": 2,
  "youtube:watchVideosInAChannel": 1,
};
const FAKE_KEY = "YOUR_AMPOST_API_KEY";
const UUID = "3f0c2a8e-6b1d-4c7a-9e52-8d4b1f6a7c30";

const built = blueprints();
const files = Object.keys(built);

describe("template files", () => {
  it("are what scripts/templates.mjs builds (run npm run build:templates)", () => {
    for (const [path, blueprint] of Object.entries(built)) {
      assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
      assert.equal(readFileSync(join(ROOT, path), "utf8"), serialize(blueprint), `${path} is out of date`);
    }
    for (const dir of ["templates/http", "templates/app"]) {
      for (const name of readdirSync(join(ROOT, dir))) assert.ok(files.includes(`${dir}/${name}`), `${dir}/${name} is not built by the script`);
    }
  });

  it("there is an HTTP and an app version of each scenario", () => {
    assert.equal(files.length, SCENARIOS.length * 2);
    for (const s of SCENARIOS) {
      const modules = (flow) => flow.map((m) => m.module).filter((m) => !m.startsWith(`${APP}:`) && m !== "http:ActionSendData" && m !== "json:TransformToJSON");
      assert.deepEqual(modules(s.app), modules(s.http), `${s.file}: both versions use the same other apps`);
    }
  });

  it("contain no API key and no connection", () => {
    for (const path of files) {
      const text = readFileSync(join(ROOT, path), "utf8");
      assert.doesNotMatch(text, /amp_(live|test)_|sk-[A-Za-z0-9]{10}|whsec_/, path);
      assert.doesNotMatch(text, /"__IMTCONN__": (?!null)/, path);
      for (const m of text.matchAll(/Bearer ([^"]+)"/g)) assert.equal(m[1], FAKE_KEY, path);
    }
  });
});

for (const [path, blueprint] of Object.entries(built)) {
  describe(path, () => {
    it("has Make's blueprint shape, known modules and mappings of earlier modules only", () => {
      assert.deepEqual(Object.keys(blueprint), ["name", "flow", "metadata"]);
      assert.equal(typeof blueprint.metadata.instant, "boolean");
      assert.equal(blueprint.metadata.instant, blueprint.flow[0].module === "gateway:CustomWebHook");
      const seen = [];
      for (const module of blueprint.flow) {
        assert.equal(module.id, seen.length + 1, "ids count up from 1");
        if (module.module.startsWith(`${APP}:`)) {
          const id = module.module.slice(APP.length + 1);
          assert.ok(manifest.components.module[id], `${module.module} is not an app module`);
          assert.equal(module.version, 1);
        } else {
          assert.equal(KNOWN_MODULES[module.module], module.version, `${module.module} v${module.version}`);
        }
        const text = JSON.stringify(module.mapper) + JSON.stringify(module.filter ?? {});
        for (const ref of text.matchAll(/\{\{[^}]*?\b(\d+)\./g)) {
          assert.ok(seen.includes(Number(ref[1])), `module ${module.id} maps module ${ref[1]}, which does not run before it`);
        }
        seen.push(module.id);
      }
    });

    it("every Ampost call carries an idempotency key", () => {
      for (const module of blueprint.flow) {
        if (module.module === "http:ActionSendData") {
          const key = module.mapper.headers.find((h) => h.name === "Idempotency-Key");
          assert.ok(key?.value.includes("{{"), `module ${module.id}: the key must depend on the item`);
        }
        if (module.module.startsWith(`${APP}:`) && ["createPost", "publishPost"].includes(module.module.slice(APP.length + 1))) {
          assert.ok(module.mapper["Idempotency-Key"]?.includes("{{"), `module ${module.id}`);
        }
      }
    });

    it("the approval webhook publishes only with the token and a UUID", () => {
      const publish = blueprint.flow.find((m) => /publish/.test(m.mapper?.url ?? "") || m.module === `${APP}:publishPost`);
      if (!publish) return;
      const conditions = publish.filter.conditions.flat();
      assert.ok(conditions.some((c) => c.a === "{{1.token}}" && c.o === "text:equal" && c.b === "YOUR_APPROVAL_TOKEN"));
      assert.ok(conditions.some((c) => c.a === "{{1.postId}}" && c.o === "text:pattern"));
      assert.equal(publish.filter.conditions.length, 1, "one AND group, so both must hold");
    });

    it("mapped text in emails is HTML-escaped", () => {
      for (const module of blueprint.flow.filter((m) => m.module === "google-email:ActionSendEmail")) {
        for (const ref of module.mapper.html.matchAll(/<blockquote>(.*?)<\/blockquote>/g)) assert.match(ref[1], /^\{\{escapeHTML\(/);
      }
    });
  });
}

/** Replaces mapped values with realistic ones: the request a run would send. */
function sampleValue(text, key) {
  if (key === "scheduledFor") return "2026-11-24T15:00:00Z";
  if (key === "postId") return UUID;
  if (key === "linkUrl") return "https://example.com/article";
  return text.replace(/\{\{.*?\}\}/g, "sample");
}

describe("HTTP versions send what the API accepts", () => {
  for (const [path, blueprint] of Object.entries(built).filter(([p]) => p.startsWith("templates/http/"))) {
    for (const module of blueprint.flow.filter((m) => m.module === "http:ActionSendData")) {
      it(`${path} module ${module.id}`, () => {
        const { mapper } = module;
        const url = new URL(mapper.url.replace(/\{\{1\.postId\}\}/, UUID));
        assert.ok(findOperation(mapper.method.toUpperCase(), url.pathname)?.operation, `${mapper.method} ${url.pathname}`);
        // Transform to JSON outputs a JSON literal; everything else is mapped inside a string.
        const body = mapper.data.replace(/\{\{\d+\.json\}\}/g, '"https://example.com/sample"').replace(/\{\{.*?\}\}/g, "2026-11-24T15:00:00Z");
        const request = {
          url: url.href,
          method: mapper.method.toUpperCase(),
          headers: Object.fromEntries(mapper.headers.map((h) => [h.name.toLowerCase(), sampleValue(h.value, h.name)])),
          type: "text",
          body,
          sanitize: ["request.headers.authorization"],
        };
        request.headers["content-type"] = mapper.contentType;
        assert.deepEqual(checkRequest(request, FAKE_KEY).errors, []);
      });
    }
  }
});

describe("app versions send what the API accepts", () => {
  for (const [path, blueprint] of Object.entries(built).filter(([p]) => p.startsWith("templates/app/"))) {
    for (const module of blueprint.flow.filter((m) => m.module.startsWith(`${APP}:`))) {
      it(`${path} module ${module.id}`, async () => {
        const id = module.module.slice(APP.length + 1);
        const { communication, mappableParams, staticParams } = component("module", id);
        // Every mapped field is a parameter of the module (nested select options included).
        const names = new Set();
        const walk = (params) => {
          for (const p of params ?? []) {
            names.add(p.name);
            for (const option of Array.isArray(p.options) ? p.options : []) walk(option.nested);
          }
        };
        walk(mappableParams);
        walk(staticParams);
        for (const key of Object.keys(module.mapper)) assert.ok(names.has(key), `${id} has no parameter ${key}`);

        const parameters = Object.fromEntries(
          Object.entries(module.mapper).map(([key, value]) => [key, typeof value === "string" ? sampleValue(value, key) : value]),
        );
        let errors;
        await runCommunication(communication, {
          parameters,
          connection: { apiKey: FAKE_KEY },
          transport: async (request) => {
            errors = checkRequest(request, FAKE_KEY).errors;
            return { statusCode: 200, body: component("module", id).samples };
          },
        });
        assert.deepEqual(errors, []);
      });
    }
  }
});

describe("the blueprints are valid against the request schema, not just parseable", () => {
  it("a post body without targets is refused by the check (the test can fail)", () => {
    assert.notDeepEqual(schemaErrors({ $ref: "#/components/schemas/CreatePostRequest" }, { text: "x" }), []);
  });
});
