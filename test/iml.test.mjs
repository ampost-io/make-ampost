// The IML in every app file parses, calls only Make's built-in functions and reads only the
// variables Make provides where it runs. Plus tests of the evaluator the other tests rely on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { manifest, readJson } from "./lib/app.mjs";
import { KNOWN_FUNCTIONS, collectNames, evaluateTemplate, expressionsIn, parseExpression, render, stringsIn } from "./lib/iml.mjs";

// Variables each kind of code can read (Make docs: "IML variables" and each component's page).
const REQUEST = ["parameters", "connection", "common", "temp", "body", "headers", "statusCode", "item", "pagination", "data", "now", "timestamp"];
const ROOTS = {
  base: [...REQUEST],
  "connection.communication": ["parameters", "common", "temp", "body", "headers", "statusCode", "data", "now"],
  "module.communication": [...REQUEST],
  "instant.communication": [...REQUEST, "payload"],
  "rpc.communication": [...REQUEST],
  "webhook.attach": [...REQUEST, "webhook"],
  "webhook.detach": [...REQUEST, "webhook"],
  "webhook.communication": ["body", "headers", "query", "method", "parameters", "connection", "common", "item", "now"],
};

function files() {
  const out = [{ path: manifest.generalCodeFiles.base, kind: "base" }];
  for (const [type, items] of Object.entries(manifest.components)) {
    for (const [id, meta] of Object.entries(items)) {
      for (const [codeType, path] of Object.entries(meta.codeFiles)) {
        if (!path) continue;
        let kind = `${type}.${codeType}`;
        if (type === "module" && codeType === "communication" && meta.moduleType === "instant_trigger") kind = "instant.communication";
        out.push({ path, kind, id });
      }
    }
  }
  return out;
}

describe("IML in the app files", () => {
  for (const { path, kind } of files()) {
    it(path, () => {
      const data = readJson(path);
      for (const [where, text] of stringsIn(data)) {
        for (const source of expressionsIn(text)) {
          let tree;
          try {
            tree = parseExpression(source);
          } catch (error) {
            assert.fail(`${path} ${where}: ${error.message}`);
          }
          const { roots, functions } = collectNames(tree);
          for (const fn of functions) assert.ok(KNOWN_FUNCTIONS.has(fn), `${path} ${where}: unknown function ${fn}()`);
          const allowed = ROOTS[kind];
          assert.ok(allowed, `${path} (${kind}) has IML but no context is defined for it: ${text}`);
          for (const root of roots) assert.ok(allowed.includes(root), `${path} ${where}: ${root} is not available in ${kind}`);
        }
      }
    });
  }
});

describe("IML evaluator", () => {
  const ctx = { parameters: { a: 1, list: [{ key: "x", value: "1" }], name: "" }, body: { files: [{ url: "u1" }, { url: "u2" }] } };

  it("returns a whole expression's raw value and joins mixed text", () => {
    assert.deepEqual(evaluateTemplate("{{parameters}}", ctx), ctx.parameters);
    assert.equal(evaluateTemplate("{{parameters.a}}", ctx), 1);
    assert.equal(evaluateTemplate("a={{parameters.a}};b={{parameters.missing}}", ctx), "a=1;b=");
  });

  it("indexes arrays from 1, and -1 is the last item", () => {
    assert.equal(evaluateTemplate("{{body.files[1].url}}", ctx), "u1");
    assert.equal(evaluateTemplate("{{body.files[-1].url}}", ctx), "u2");
    assert.equal(evaluateTemplate("{{body.files[3].url}}", ctx), undefined);
  });

  it("compares strictly, with = and == the same as ===", () => {
    assert.equal(evaluateTemplate("{{parameters.a == '1'}}", ctx), false);
    assert.equal(evaluateTemplate("{{parameters.a = 1}}", ctx), true);
    assert.equal(evaluateTemplate("{{parameters.a != 1 || parameters.a + 1 === 2}}", ctx), true);
  });

  it("if, ifempty, omit, pick, toCollection", () => {
    assert.equal(evaluateTemplate("{{if(parameters.a, 'yes', 'no')}}", ctx), "yes");
    assert.equal(evaluateTemplate("{{ifempty(parameters.name, 'fallback')}}", ctx), "fallback");
    assert.equal(evaluateTemplate("{{ifempty(0, 'fallback')}}", ctx), 0);
    assert.deepEqual(evaluateTemplate("{{omit(parameters, 'list', 'name')}}", ctx), { a: 1 });
    assert.deepEqual(evaluateTemplate("{{pick(parameters, 'a', 'nope')}}", ctx), { a: 1 });
    assert.deepEqual(evaluateTemplate("{{toCollection(parameters.list, 'key', 'value')}}", ctx), { x: "1" });
  });

  it("spreads a collection and leaves out keys that are undefined", () => {
    const result = render({ "{{...}}": "{{omit(parameters, 'list', 'name')}}", name: "{{undefined}}", b: "{{parameters.a * 2}}" }, ctx);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("evaluates every function argument, like Make: if() does not skip the unused branch", () => {
    assert.throws(() => evaluateTemplate("{{if(parameters.missing, parseJSON(parameters.missing), undefined)}}", ctx), SyntaxError);
    assert.equal(evaluateTemplate("{{if(parameters.missing, parseJSON(ifempty(parameters.missing, 'null')), undefined)}}", ctx), undefined);
  });

  it("fails on unknown functions and bad syntax", () => {
    assert.throws(() => evaluateTemplate("{{nope(1)}}", ctx), /Unknown IML function/);
    assert.throws(() => evaluateTemplate("{{parameters.a +}}", ctx), SyntaxError);
    assert.throws(() => evaluateTemplate("{{'open}}", ctx), SyntaxError);
  });
});
