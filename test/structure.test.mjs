// The app's files against Make's own editor schemas, and the references between them.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import AjvModule from "ajv";
import { ROOT, manifest, readJson } from "./lib/app.mjs";

const Ajv = AjvModule.default ?? AjvModule;
// Settings the schemas need (see schemas/README.md).
const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
const SCHEMA_DIR = join(ROOT, "schemas");
for (const name of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith(".json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")), name);
}

// Code type -> editor schema, from the VS Code extension's jsonValidation mapping.
const SCHEMA_BY_CODE = {
  connection: { communication: "api.json", params: "parameters.json", common: "common.json" },
  webhook: { params: "parameters.json", attach: "api.json", detach: "api.json", requiredScope: "scope.json", communication: null, update: null },
  module: {
    communication: "api.json",
    staticParams: "parameters.json",
    mappableParams: "parameters.json",
    interface: "parameters.json",
    samples: "samples.json",
    epoch: "epoch.json",
    scope: "scope.json",
  },
  rpc: { communication: "api.json", params: "parameters.json" },
};

function check(schema, data, file) {
  const validate = ajv.getSchema(schema);
  assert.ok(validate, `schema ${schema} is missing`);
  const ok = validate(data);
  assert.ok(ok, `${file} breaks ${schema}:\n${JSON.stringify(validate.errors, null, 2)}`);
}

const components = Object.entries(manifest.components).flatMap(([type, items]) =>
  Object.entries(items).map(([id, meta]) => ({ type, id, meta })),
);

describe("editor schemas", () => {
  it("makecomapp.json", () => check("makecomapp.schema.json", manifest, "makecomapp.json"));
  it("general/base", () => check("base.json", readJson(manifest.generalCodeFiles.base), manifest.generalCodeFiles.base));
  it("modules/groups", () => check("groups.json", readJson(manifest.generalCodeFiles.groups), manifest.generalCodeFiles.groups));

  for (const { type, id, meta } of components) {
    for (const [codeType, path] of Object.entries(meta.codeFiles)) {
      if (!path) continue;
      const schema = SCHEMA_BY_CODE[type]?.[codeType];
      if (schema === null) continue; // Make has no editor schema for it
      it(`${type} ${id}: ${codeType}`, () => {
        assert.ok(schema, `no schema mapping for ${type} ${codeType}`);
        check(schema, readJson(path), path);
      });
    }
  }
});

describe("makecomapp.json references", () => {
  it("every code file exists, and every file in a component folder is listed", () => {
    const listed = new Set(Object.values(manifest.generalCodeFiles).filter(Boolean));
    for (const { meta } of components) for (const path of Object.values(meta.codeFiles)) if (path) listed.add(path);
    for (const path of listed) assert.ok(existsSync(join(ROOT, path)), `${path} is listed but missing`);
    const onDisk = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else onDisk.push(relative(ROOT, full).split(sep).join("/")); // makecomapp.json uses "/" on every OS
      }
    };
    for (const dir of ["connections", "webhooks", "modules", "rpcs", "functions", "general"]) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
    for (const path of onDisk) assert.ok(listed.has(path), `${path} is not listed in makecomapp.json`);
  });

  it("the code files that exist for each component type are all mapped (null when unused)", () => {
    const expected = {
      connection: ["communication", "params", "common"],
      webhook: ["communication", "params", "attach", "detach", "update", "requiredScope"],
      rpc: ["communication", "params"],
    };
    for (const { type, id, meta } of components) {
      let keys = expected[type];
      if (type === "module") {
        keys = ["communication", "staticParams", "mappableParams", "interface", "samples"];
        if (meta.moduleType === "trigger") keys.push("epoch");
        if (["trigger", "action", "search", "universal"].includes(meta.moduleType)) keys.push("scope");
      }
      assert.deepEqual(Object.keys(meta.codeFiles).sort(), [...keys].sort(), `${type} ${id}`);
    }
  });

  it("modules, webhooks and RPCs use the ampost connection; instant triggers name an existing webhook", () => {
    for (const { type, id, meta } of components.filter((c) => ["module", "webhook", "rpc"].includes(c.type))) {
      assert.equal(meta.connection, "ampost", `${type} ${id}`);
      assert.ok(manifest.components.connection[meta.connection]);
    }
    for (const [id, meta] of Object.entries(manifest.components.module)) {
      if (meta.moduleType === "instant_trigger") assert.ok(manifest.components.webhook[meta.webhook], `${id} webhook`);
      else assert.equal(meta.webhook, undefined, `${id} has a webhook but is ${meta.moduleType}`);
    }
  });

  it("every rpc:// option points at an RPC", () => {
    const text = components.flatMap(({ meta }) => Object.values(meta.codeFiles).filter(Boolean).map((p) => readFileSync(join(ROOT, p), "utf8")));
    const refs = text.flatMap((t) => [...t.matchAll(/rpc:\/\/([A-Za-z0-9]+)/g)].map((m) => m[1]));
    assert.ok(refs.length > 0);
    for (const ref of refs) assert.ok(manifest.components.rpc[ref], `rpc://${ref} does not exist`);
  });

  it("groups list every module exactly once", () => {
    const grouped = readJson(manifest.generalCodeFiles.groups).flatMap((g) => g.modules);
    assert.deepEqual([...grouped].sort(), Object.keys(manifest.components.module).sort());
  });

  it("there is one universal module, labeled as Make asks", () => {
    const universal = Object.values(manifest.components.module).filter((m) => m.moduleType === "universal");
    assert.equal(universal.length, 1);
    assert.equal(universal[0].label, "Make an API call");
    assert.equal(universal[0].description, "Performs an arbitrary authorized API call.");
  });

  it("component IDs are camelCase and files sit in the kebab-case folder Make's tooling uses", () => {
    for (const { type, id, meta } of components) {
      assert.match(id, /^[a-z][A-Za-z0-9]+$/, `${type} ${id}`);
      const kebab = id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      for (const path of Object.values(meta.codeFiles).filter(Boolean)) assert.ok(path.startsWith(`${type}s/${kebab}/${kebab}.`), path);
    }
  });

  it("no origin is committed: the owner adds one and keeps the token in .secrets/", () => {
    assert.deepEqual(manifest.origins, []);
    assert.match(readFileSync(join(ROOT, ".gitignore"), "utf8"), /^\.secrets\/$/m);
  });

  it("validate and create take the same post fields", () => {
    const create = readJson(manifest.components.module.createPost.codeFiles.mappableParams);
    const validate = readJson(manifest.components.module.validatePost.codeFiles.mappableParams);
    assert.deepEqual(create.filter((p) => p.name !== "Idempotency-Key"), validate);
    const createBody = readJson(manifest.components.module.createPost.codeFiles.communication).body;
    const validateBody = readJson(manifest.components.module.validatePost.codeFiles.communication).body;
    assert.deepEqual(createBody, validateBody);
  });
});
