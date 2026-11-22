// A small parser and evaluator for the part of Make's IML that this app uses. It is a test
// tool, not Make's engine: it follows the documented rules (strict equality, 1-based arrays,
// `undefined` drops a key, the `{{...}}` spread key) and fails on anything it doesn't know, so
// a typo in an expression or a function Make doesn't have fails the tests.
// Docs: https://developers.make.com/custom-apps-documentation/block-elements/iml

import { createHash } from "node:crypto";

/** Built-in IML functions documented by Make. Only some are implemented below. */
export const KNOWN_FUNCTIONS = new Set([
  // general
  "get", "if", "ifempty", "switch", "omit", "pick",
  // text
  "ascii", "base64", "capitalize", "contains", "decodeURL", "encodeURL", "escapeHTML", "escapeMarkdown",
  "indexOf", "length", "lower", "md5", "mime", "replace", "replaceEmojiCharacters", "sha1", "sha256",
  "sha512", "split", "startcase", "stripHTML", "substring", "toBinary", "toString", "trim", "upper",
  // arrays
  "add", "deduplicate", "distinct", "first", "flatten", "join", "keys", "last", "map", "merge", "remove",
  "reverse", "shuffle", "slice", "sort", "toArray", "toCollection",
  // dates
  "addDays", "addHours", "addMinutes", "addMonths", "addSeconds", "addYears", "formatDate", "parseDate",
  "setDate", "setDay", "setHour", "setMinute", "setMonth", "setSecond", "setYear",
  // numbers
  "average", "ceil", "floor", "formatNumber", "max", "min", "parseNumber", "round", "sum", "trunc",
  // JSON
  "createJSON", "parseJSON",
]);

const KEYWORDS = { true: true, false: false, null: null, undefined: undefined };

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

/** JS-like truthiness; IML's `if` treats an empty string, 0, null and undefined as false. */
export function truthy(value) {
  return Boolean(value);
}

const FUNCTIONS = {
  if: (condition, then, otherwise) => (truthy(condition) ? then : otherwise),
  ifempty: (value, fallback) => (isEmpty(value) ? fallback : value),
  get: (object, path) => {
    let current = object;
    for (const key of String(path).split(".")) current = current == null ? undefined : current[key];
    return current;
  },
  omit: (object, ...keys) => {
    if (object == null || typeof object !== "object") return {};
    return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
  },
  pick: (object, ...keys) => {
    if (object == null || typeof object !== "object") return {};
    return Object.fromEntries(Object.entries(object).filter(([key]) => keys.includes(key)));
  },
  toCollection: (array, keyName, valueName) => {
    if (!Array.isArray(array)) return {};
    return Object.fromEntries(array.map((item) => [item[keyName], item[valueName]]));
  },
  parseJSON: (text) => JSON.parse(text),
  createJSON: (value) => JSON.stringify(value),
  encodeURL: (text) => encodeURIComponent(String(text ?? "")),
  md5: (text) => createHash("md5").update(String(text ?? "")).digest("hex"),
  length: (value) => (value == null ? 0 : value.length),
  contains: (value, search) => (Array.isArray(value) ? value.includes(search) : String(value ?? "").includes(search)),
  lower: (text) => String(text ?? "").toLowerCase(),
  upper: (text) => String(text ?? "").toUpperCase(),
  trim: (text) => String(text ?? "").trim(),
  join: (array, separator) => (Array.isArray(array) ? array.join(separator) : ""),
};

// ---------- tokenizer ----------

const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ",", "."];

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i));
      tokens.push({ type: "number", value: Number(match[0]) });
      i += match[0].length;
    } else if (ch === "'" || ch === '"') {
      let value = "";
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j += 1;
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new SyntaxError(`Unterminated string in: ${source}`);
      tokens.push({ type: "string", value });
      i = j + 1;
    } else if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end === -1) throw new SyntaxError(`Unterminated backtick name in: ${source}`);
      tokens.push({ type: "name", value: source.slice(i + 1, end), quoted: true });
      i = end + 1;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
      tokens.push({ type: "name", value: match[0] });
      i += match[0].length;
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i));
      if (!op) throw new SyntaxError(`Unexpected character "${ch}" in: ${source}`);
      tokens.push({ type: "op", value: op });
      i += op.length;
    }
  }
  return tokens;
}

// ---------- parser ----------

const BINARY_LEVELS = [
  ["||"],
  ["&&"],
  ["===", "!==", "==", "!=", "="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

/** Parses one expression (the text between `{{` and `}}`) into a tree. */
export function parseExpression(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value) => peek()?.type === "op" && peek().value === value;
  const expect = (value) => {
    if (!isOp(value)) throw new SyntaxError(`Expected "${value}" at token ${pos} in: ${source}`);
    pos += 1;
  };

  function binary(level) {
    if (level === BINARY_LEVELS.length) return unary();
    let left = binary(level + 1);
    while (peek()?.type === "op" && BINARY_LEVELS[level].includes(peek().value)) {
      const op = tokens[pos++].value;
      left = { kind: "binary", op, left, right: binary(level + 1) };
    }
    return left;
  }
  function unary() {
    if (isOp("!") || isOp("-")) {
      const op = tokens[pos++].value;
      return { kind: "unary", op, argument: unary() };
    }
    return postfix();
  }
  function postfix() {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        pos += 1;
        const name = peek();
        if (name?.type !== "name") throw new SyntaxError(`Expected a property name in: ${source}`);
        pos += 1;
        node = { kind: "member", object: node, property: { kind: "literal", value: name.value } };
      } else if (isOp("[")) {
        pos += 1;
        const property = binary(0);
        expect("]");
        node = { kind: "index", object: node, property };
      } else if (isOp("(")) {
        if (node.kind !== "identifier") throw new SyntaxError(`Only named functions can be called in: ${source}`);
        pos += 1;
        const args = [];
        if (!isOp(")")) {
          args.push(binary(0));
          while (isOp(",")) {
            pos += 1;
            args.push(binary(0));
          }
        }
        expect(")");
        node = { kind: "call", name: node.name, args };
      } else {
        return node;
      }
    }
  }
  function primary() {
    const token = tokens[pos++];
    if (!token) throw new SyntaxError(`Unexpected end of: ${source}`);
    if (token.type === "number" || token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "name") {
      if (!token.quoted && token.value in KEYWORDS) return { kind: "literal", value: KEYWORDS[token.value] };
      if (!token.quoted && token.value === "emptyarray") return { kind: "emptyarray" };
      return { kind: "identifier", name: token.value };
    }
    if (token.value === "(") {
      const inner = binary(0);
      expect(")");
      return inner;
    }
    throw new SyntaxError(`Unexpected "${token.value}" in: ${source}`);
  }

  const tree = binary(0);
  if (pos !== tokens.length) throw new SyntaxError(`Unexpected "${tokens[pos].value}" in: ${source}`);
  return tree;
}

/** Root variables and functions an expression uses, for static checks. */
export function collectNames(tree, found = { roots: new Set(), functions: new Set() }) {
  if (!tree || typeof tree !== "object") return found;
  if (tree.kind === "identifier") found.roots.add(tree.name);
  if (tree.kind === "call") found.functions.add(tree.name);
  for (const value of Object.values(tree)) {
    if (Array.isArray(value)) value.forEach((v) => collectNames(v, found));
    else if (value && typeof value === "object") collectNames(value, found);
  }
  return found;
}

// ---------- evaluator ----------

function evaluate(node, context) {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "emptyarray":
      return [];
    case "identifier":
      if (node.name in FUNCTIONS) throw new Error(`${node.name} is a function, not a variable`);
      return context[node.name];
    case "member":
    case "index": {
      const object = evaluate(node.object, context);
      const key = evaluate(node.property, context);
      if (object === undefined || object === null) return undefined;
      if (Array.isArray(object) && node.kind === "index" && typeof key === "number") {
        // IML arrays are 1-based; negative indexes count from the end.
        return key < 0 ? object[object.length + key] : object[key - 1];
      }
      return object[key];
    }
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) {
        throw new Error(
          KNOWN_FUNCTIONS.has(node.name)
            ? `IML function ${node.name}() is not implemented in the test evaluator`
            : `Unknown IML function ${node.name}()`,
        );
      }
      return fn(...node.args.map((arg) => evaluate(arg, context)));
    }
    case "unary": {
      const value = evaluate(node.argument, context);
      return node.op === "!" ? !truthy(value) : -value;
    }
    case "binary": {
      if (node.op === "&&") {
        const left = evaluate(node.left, context);
        return truthy(left) ? evaluate(node.right, context) : left;
      }
      if (node.op === "||") {
        const left = evaluate(node.left, context);
        return truthy(left) ? left : evaluate(node.right, context);
      }
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      switch (node.op) {
        case "=":
        case "==":
        case "===":
          return left === right;
        case "!=":
        case "!==":
          return left !== right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "+":
          return typeof left === "number" && typeof right === "number" ? left + right : `${left ?? ""}${right ?? ""}`;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
      }
    }
  }
  throw new Error(`Cannot evaluate node ${node.kind}`);
}

const TEMPLATE = /\{\{([\s\S]*?)\}\}/g;
const WHOLE = /^\{\{([\s\S]*)\}\}$/;

/** The expressions inside a string, e.g. "a {{b}} c" -> ["b"]. */
export function expressionsIn(text) {
  return [...text.matchAll(TEMPLATE)].map((m) => m[1]).filter((source) => source !== "...");
}

/**
 * Evaluates a string. A string that is one whole expression returns its raw value (object,
 * number, undefined); otherwise the parts are joined as text, with null and undefined as "".
 */
export function evaluateTemplate(text, context) {
  const whole = WHOLE.exec(text);
  if (whole && !whole[1].includes("}}")) return evaluate(parseExpression(whole[1]), context);
  return text.replace(TEMPLATE, (_, source) => {
    const value = evaluate(parseExpression(source), context);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/**
 * Evaluates every string in a JSON value. In a collection the `"{{...}}"` key merges the
 * collection it evaluates to, and a key whose value is `undefined` is left out.
 */
export function render(value, context) {
  if (typeof value === "string") return evaluateTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "{{...}}") {
        const spread = render(inner, context);
        if (spread && typeof spread === "object" && !Array.isArray(spread)) {
          for (const [k, v] of Object.entries(spread)) if (v !== undefined) result[k] = v;
        }
        continue;
      }
      const rendered = render(inner, context);
      if (rendered !== undefined) result[evaluateTemplate(key, context)] = rendered;
    }
    return result;
  }
  return value;
}

/** Every string in a JSON value (keys included), with its JSON path. */
export function* stringsIn(value, path = "") {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* stringsIn(item, `${path}[${i}]`);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      yield [`${path}{key}`, key];
      yield* stringsIn(inner, `${path}.${key}`);
    }
  }
}
