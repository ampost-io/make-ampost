// The scenario templates. Each scenario is defined once and built in two versions:
//   templates/http/  Make's HTTP module, works with any Make account today
//   templates/app/   the Ampost app's modules (after the app is installed)
// `npm run build:templates` writes the files; test/templates.test.mjs fails when they differ.
//
// Placeholders the user replaces after import are in CAPITALS: YOUR_AMPOST_API_KEY,
// YOUR_APPROVAL_TOKEN, YOUR_APPROVAL_WEBHOOK_URL, YOUR_SPREADSHEET_ID, YOUR_CHANNEL_ID,
// you@example.com. Connections of other apps (Google, OpenAI, YouTube) are left empty: Make asks
// for them on import.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = "ampost";
export const API = "https://api.ampost.io";
// Platforms that take a text post with a link. Instagram, TikTok, YouTube and Pinterest need media.
export const TEXT_PLATFORMS = ["linkedin", "facebook", "threads", "twitter", "bluesky", "telegram", "discord"];

const at = (x) => ({ designer: { x, y: 0 } });

function trigger(id, module, version, parameters, mapper = {}) {
  return { id, module, version, parameters, mapper, metadata: at(0) };
}

/** Make's HTTP module: one Ampost API call with the key in a header. */
function httpCall(id, { method, path, data, idempotencyKey }) {
  return {
    id,
    module: "http:ActionSendData",
    version: 3,
    parameters: { handleErrors: true, useNewZLibDeCompress: true },
    mapper: {
      ca: "",
      qs: [],
      url: `${API}${path}`,
      gzip: true,
      method,
      headers: [
        { name: "Authorization", value: "Bearer YOUR_AMPOST_API_KEY" },
        { name: "Idempotency-Key", value: idempotencyKey },
      ],
      timeout: "",
      useMtls: false,
      authPass: "",
      authUser: "",
      bodyType: "raw",
      contentType: "application/json",
      data,
      serializeUrl: false,
      shareCookies: false,
      parseResponse: true,
      followRedirect: true,
      useQuerystring: false,
      followAllRedirects: false,
      rejectUnauthorized: true,
    },
    metadata: at(id * 300),
  };
}

/** Make's "Transform to JSON": turns a mapped value into a JSON literal, quotes escaped. */
function toJson(id, object) {
  return { id, module: "json:TransformToJSON", version: 1, parameters: { space: "" }, mapper: { object }, metadata: at(id * 300) };
}

function appModule(id, module, mapper) {
  return { id, module: `${APP}:${module}`, version: 1, parameters: { __IMTCONN__: null }, mapper, metadata: at(id * 300) };
}

function step(id, module, version, parameters, mapper, extra = {}) {
  return { id, module, version, parameters, mapper, ...extra, metadata: at(id * 300) };
}

const scenarioMetadata = (instant) => ({
  instant,
  version: 1,
  designer: { orphans: [] },
  scenario: {
    dlq: false,
    slots: null,
    dataloss: false,
    maxErrors: 3,
    autoCommit: true,
    roundtrips: 1,
    sequential: false,
    confidential: false,
    freshVariables: false,
    autoCommitTriggerLast: true,
  },
});

/** The JSON body of POST /api/posts, with text (and link) mapped from Transform to JSON modules. */
const postBody = ({ text, linkUrl, extra = "", platforms = TEXT_PLATFORMS }) =>
  `{"targets": [{"platforms": ${JSON.stringify(platforms)}}], "text": ${text}` + (linkUrl ? `, "linkUrl": ${linkUrl}` : "") + extra + "}";

const appTargets = [{ platforms: TEXT_PLATFORMS }];

// The approval link the AI scenario emails and the approval scenario receives.
const APPROVAL_LINK = (postId) => `YOUR_APPROVAL_WEBHOOK_URL?postId=${postId}&token=YOUR_APPROVAL_TOKEN`;
const APPROVAL_FILTER = {
  name: "Approval token matches and the post ID is a UUID",
  conditions: [
    [
      { a: "{{1.token}}", b: "YOUR_APPROVAL_TOKEN", o: "text:equal" },
      { a: "{{1.postId}}", b: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", o: "text:pattern" },
    ],
  ],
};
const OPENAI = (id) =>
  step(id, "openai-gpt-3:CreateCompletion", 1, { __IMTCONN__: null }, {
    select: "chat",
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You write short social media posts for our brand. Plain text, at most 280 characters, no hashtags unless asked, no quotes around the post.",
      },
      { role: "user", content: "Write a post about: {{1.topic}}" },
    ],
    max_tokens: "300",
    temperature: "0.7",
    n_completions: "1",
    response_format: "text",
  });
const APPROVAL_EMAIL = (id, textRef, postRef) =>
  step(id, "google-email:ActionSendEmail", 2, { __IMTCONN__: null }, {
    to: ["you@example.com"],
    subject: "Approve this post?",
    html: `<p>The AI wrote this draft:</p><blockquote>${textRef}</blockquote><p><a href="${APPROVAL_LINK(postRef)}">Approve and publish now</a></p><p>Or edit or delete the draft in Ampost: https://ampost.io/app</p>`,
    cc: [],
    bcc: [],
    attachments: [],
  });
const respond = (id, body, status = "200") =>
  step(id, "gateway:WebhookRespond", 1, {}, { body, status, headers: [{ key: "Content-Type", value: "application/json" }] });

const SHEET = { mode: "select", spreadsheetId: "YOUR_SPREADSHEET_ID", sheetId: "Posts", includesHeaders: true };
const SHEETS_WATCH = trigger(1, "google-sheets:watchRows", 2, { __IMTCONN__: null, ...SHEET, tableFirstRow: "A1:Z1", limit: 10 });
// Columns: A Text, B Publish at (ISO 8601 with a time zone), C Link URL (optional), D Post ID, E Status.
const SHEETS_UPDATE = (id, postRef, statusRef) =>
  step(id, "google-sheets:updateRow", 2, { __IMTCONN__: null }, {
    ...SHEET,
    rowNumber: "{{1.`__ROW_NUMBER__`}}",
    values: { 3: postRef, 4: statusRef },
  });

const RSS = trigger(1, "rss:TriggerNewArticle", 4, { url: "https://example.com/feed.xml", maxResults: 1, include: [] });
const YOUTUBE = trigger(1, "youtube:watchVideosInAChannel", 1, { __IMTCONN__: null, channelId: "YOUR_CHANNEL_ID", limit: 1 });
const WEBHOOK = trigger(1, "gateway:CustomWebHook", 1, { hook: null, maxResults: 1 });

// The how-to's scenario (ampost.io/how-to/post-to-social-media-from-make): the webhook takes
// {"text", "link", "id"}; link and id are optional. The platforms are set in the scenario.
const HOW_TO_PLATFORMS = ["bluesky", "threads"];
const HOW_TO_KEY = "webhook-{{ifempty(1.id; md5(1.text))}}";

/** Each scenario: a file name, a title and the two flows. */
export const SCENARIOS = [
  {
    file: "post-to-social-media",
    title: "Post to social media from a webhook",
    summary: "Gets a post by webhook (text, optional link), publishes it now and answers with the post ID and status.",
    instant: true,
    http: [
      WEBHOOK,
      toJson(2, "{{1.text}}"),
      toJson(3, "{{ifempty(1.link; null)}}"),
      httpCall(4, {
        method: "post",
        path: "/api/posts",
        data: postBody({ text: "{{2.json}}", linkUrl: "{{3.json}}", extra: ', "publishNow": true', platforms: HOW_TO_PLATFORMS }),
        idempotencyKey: HOW_TO_KEY,
      }),
      respond(5, '{"postId": "{{4.data.id}}", "status": "{{4.data.status}}"}'),
    ],
    app: [
      WEBHOOK,
      appModule(2, "createPost", {
        targets: [{ platforms: HOW_TO_PLATFORMS }],
        text: "{{1.text}}",
        linkUrl: "{{ifempty(1.link; null)}}",
        when: "now",
        "Idempotency-Key": HOW_TO_KEY,
      }),
      respond(3, '{"postId": "{{2.id}}", "status": "{{2.status}}"}'),
    ],
  },
  {
    file: "rss-to-all-platforms",
    title: "RSS feed to all platforms",
    summary: "Posts each new article of an RSS feed (title and link) to every text platform.",
    instant: false,
    http: [
      RSS,
      toJson(2, "{{1.title}}"),
      toJson(3, "{{1.url}}"),
      httpCall(4, { method: "post", path: "/api/posts", data: postBody({ text: "{{2.json}}", linkUrl: "{{3.json}}", extra: ', "publishNow": true' }), idempotencyKey: "rss-{{md5(1.url)}}" }),
    ],
    app: [
      RSS,
      appModule(2, "createPost", { targets: appTargets, text: "{{1.title}}", linkUrl: "{{1.url}}", when: "now", "Idempotency-Key": "rss-{{md5(1.url)}}" }),
    ],
  },
  {
    file: "google-sheets-schedule",
    title: "Schedule posts from Google Sheets",
    summary: "Schedules each new row of a sheet (text, time, link) and writes the post ID and status back.",
    instant: false,
    http: [
      SHEETS_WATCH,
      toJson(2, "{{1.`0`}}"),
      toJson(3, "{{ifempty(1.`2`; null)}}"),
      httpCall(4, {
        method: "post",
        path: "/api/posts",
        data: postBody({ text: "{{2.json}}", linkUrl: "{{3.json}}", extra: ', "scheduledFor": "{{1.`1`}}"' }),
        idempotencyKey: "sheet-{{1.`__ROW_NUMBER__`}}-{{md5(1.`0`)}}",
      }),
      SHEETS_UPDATE(5, "{{4.data.id}}", "{{4.data.status}}"),
    ],
    app: [
      SHEETS_WATCH,
      appModule(2, "createPost", {
        targets: appTargets,
        text: "{{1.`0`}}",
        linkUrl: "{{ifempty(1.`2`; null)}}",
        when: "schedule",
        scheduledFor: "{{1.`1`}}",
        "Idempotency-Key": "sheet-{{1.`__ROW_NUMBER__`}}-{{md5(1.`0`)}}",
      }),
      SHEETS_UPDATE(3, "{{2.id}}", "{{2.status}}"),
    ],
  },
  {
    file: "ai-post-with-approval",
    title: "AI-written post with approval (1 of 2: write and ask)",
    summary: "Gets a topic by webhook, has OpenAI write a post, saves it as an Ampost draft and emails an approval link.",
    instant: true,
    http: [
      WEBHOOK,
      OPENAI(2),
      toJson(3, "{{2.result}}"),
      httpCall(4, { method: "post", path: "/api/posts", data: postBody({ text: "{{3.json}}" }), idempotencyKey: "ai-{{md5(2.result)}}" }),
      APPROVAL_EMAIL(5, "{{escapeHTML(2.result)}}", "{{4.data.id}}"),
      respond(6, '{"postId": "{{4.data.id}}", "status": "{{4.data.status}}"}'),
    ],
    app: [
      WEBHOOK,
      OPENAI(2),
      appModule(3, "createPost", { targets: appTargets, text: "{{2.result}}", when: "draft", "Idempotency-Key": "ai-{{md5(2.result)}}" }),
      APPROVAL_EMAIL(4, "{{escapeHTML(2.result)}}", "{{3.id}}"),
      respond(5, '{"postId": "{{3.id}}", "status": "{{3.status}}"}'),
    ],
  },
  {
    file: "ai-post-approve",
    title: "AI-written post with approval (2 of 2: publish on approval)",
    summary: "The approval link's webhook: checks the token and publishes the draft.",
    instant: true,
    http: [
      WEBHOOK,
      {
        ...httpCall(2, { method: "post", path: "/api/posts/{{1.postId}}/publish", data: "{}", idempotencyKey: "approve-{{1.postId}}" }),
        filter: APPROVAL_FILTER,
      },
      respond(3, '{"postId": "{{2.data.id}}", "status": "{{2.data.status}}"}'),
    ],
    app: [
      WEBHOOK,
      { ...appModule(2, "publishPost", { postId: "{{1.postId}}", "Idempotency-Key": "approve-{{1.postId}}" }), filter: APPROVAL_FILTER },
      respond(3, '{"postId": "{{2.id}}", "status": "{{2.status}}"}'),
    ],
  },
  {
    file: "youtube-upload-cross-post",
    title: "Cross-post new YouTube uploads",
    summary: "Posts each new video of a YouTube channel (title and link) to every text platform.",
    instant: false,
    http: [
      YOUTUBE,
      toJson(2, "New video: {{1.title}}"),
      httpCall(3, {
        method: "post",
        path: "/api/posts",
        data: postBody({ text: "{{2.json}}", linkUrl: '"https://www.youtube.com/watch?v={{1.id}}"', extra: ', "publishNow": true' }),
        idempotencyKey: "youtube-{{1.id}}",
      }),
    ],
    app: [
      YOUTUBE,
      appModule(2, "createPost", {
        targets: appTargets,
        text: "New video: {{1.title}}",
        linkUrl: "https://www.youtube.com/watch?v={{1.id}}",
        when: "now",
        "Idempotency-Key": "youtube-{{1.id}}",
      }),
    ],
  },
];

export function blueprints() {
  const out = {};
  for (const s of SCENARIOS) {
    out[`templates/http/${s.file}.blueprint.json`] = { name: `${s.title} (HTTP)`, flow: s.http, metadata: scenarioMetadata(s.instant) };
    out[`templates/app/${s.file}.blueprint.json`] = { name: `${s.title} (Ampost app)`, flow: s.app, metadata: scenarioMetadata(s.instant) };
  }
  return out;
}

export const serialize = (blueprint) => JSON.stringify(blueprint, null, 2) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  for (const [path, blueprint] of Object.entries(blueprints())) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), serialize(blueprint));
    console.log(path);
  }
}
