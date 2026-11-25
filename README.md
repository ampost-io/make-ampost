# Ampost for Make

The source of the Ampost custom app for [Make](https://www.make.com), plus ready-made scenario
templates. With the [Ampost API](https://ampost.io/docs?ref=github), a Make scenario can publish,
schedule and track posts on Instagram, Facebook, LinkedIn, TikTok, Threads, X, YouTube, Pinterest,
Bluesky, Telegram and Discord.

- **The app** (`makecomapp.json` and its folders): 17 modules, two pickers and two instant
  triggers, in the local-development layout of Make's
  [VS Code extension](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk).
- **Templates** (`templates/`): six scenario blueprints, each in two versions. `templates/http/`
  uses Make's HTTP module and works in any Make account today. `templates/app/` uses this app.

Step-by-step guide: [Post to social media from Make](https://ampost.io/how-to/post-to-social-media-from-make?ref=github).

## What the app does

| Group | Module | Type | API |
| ----- | ------ | ---- | --- |
| Triggers | Watch post events | instant | a webhook for `post.*` events; the post is re-read with your key |
| | Watch account events | instant | a webhook for `account.*` events |
| Posts | Search posts | search | `GET /api/posts`, paged |
| | Get a post | action | `GET /api/posts/{id}` |
| | Create a post | action | `POST /api/posts`: draft, publish now, schedule or add to the queue |
| | Validate a post | action | `POST /api/posts/validate`: each platform's verdict, nothing is created |
| | Publish a post now | action | `POST /api/posts/{id}/publish` |
| | Retry a failed post | action | `POST /api/posts/{id}/retry` |
| | Edit a published post | action | `POST /api/posts/{id}/edit-published`: replaces the text (Instagram, Threads, TikTok, Bluesky and X keep theirs, with a notice) |
| | Unpublish a post | action | `POST /api/posts/{id}/unpublish`: deletes a published post from the platforms (Instagram and TikTok keep it, with a notice) |
| | Delete a post | action | `DELETE /api/posts/{id}` |
| Media | Upload a media file | action | `POST /api/media/uploads`, then the file goes straight to storage; returns the upload and the URL for Create a post |
| Accounts | List accounts | search | `GET /api/accounts` |
| | List platform sets | search | `GET /api/platform-sets` |
| | List queue slots | search | `GET /api/platform-sets/{id}/queue/slots` |
| Analytics | List post analytics | search | `GET /api/analytics/posts` |
| | Get an analytics overview | action | `GET /api/analytics/overview` |
| | List follower counts | search | `GET /api/analytics/followers` |
| Other | Make an API call | universal | any endpoint under `https://api.ampost.io/api`, with the connection's key |

- **Connection:** an Ampost API key. Make checks it with one docs search call. Create the key in
  [Settings, API keys](https://ampost.io/app/settings/api-keys?ref=github). The two triggers need a key
  that can write webhooks.
- **Pickers:** the Platform set, Account and Post ID fields list your sets, accounts and newest 300
  posts; each also takes a mapped ID.
- **Platform options:** Create a post and Validate a post have fields for YouTube, TikTok,
  Pinterest, Instagram, Facebook and LinkedIn options, and an advanced JSON field for the rest.
- **Dates** come out as Make dates. Dates inside arrays (a post's platform posts, analytics history)
  stay ISO 8601 text.
- **Safe retries:** Create a post and Publish a post now take an optional Idempotency key. Map
  something unique per item, such as a sheet row or a feed item's URL. If Make runs the module
  again, it returns the first result instead of posting twice.
- **Errors** show the API's message and code, for example
  `[401] Send a valid API key as a Bearer token, or sign in. (UNAUTHORIZED)`.
- The API key never appears in Make's logs. Upload a media file sends the file to storage with a
  one-time upload token, not with your API key.

OAuth is not offered: the Ampost API takes API keys, and Ampost's OAuth tokens are only for its MCP
server.

## Install the app (private, for your own Make account)

1. Install [VS Code](https://code.visualstudio.com) and the **Make Apps Editor** extension.
2. In Make, open your profile, **API access**, and create an API token with the custom-app scopes
   (read and write apps).
3. In Make, open **Custom apps** and create an app named `ampost` (Make may add a suffix).
4. Clone this repo and open the folder in VS Code. Right-click `makecomapp.json` and choose
   **Deploy to Make**. The first time, it asks for your Make zone (for example
   `eu1.make.com`), the token from step 2 and the app. It saves the token under `.secrets/`, which
   git ignores.
5. In a scenario, add an **Ampost** module and create a connection with your Ampost API key.

To change the app later, edit the files and deploy again. To bring changes made in Make's web
editor back into these files, use **Download from Make** on `makecomapp.json`.

Without VS Code, `scripts/deploy.mjs` uploads the same files through Make's API (Node 18+). The token
needs the `sdk-apps:read` and `sdk-apps:write` scopes. The first run creates the app and prints its
name; later runs update it:

```sh
MAKE_API_TOKEN=... node scripts/deploy.mjs
MAKE_API_TOKEN=... MAKE_APP=ampost-xxxx node scripts/deploy.mjs
```

The app icon is `assets/icon.png` (rendered from `assets/icon.svg`): Make shows its black areas
white on the app's theme color.

## Templates

| Scenario | File | What it does |
| -------- | ---- | ------------ |
| Post from a webhook | `post-to-social-media.blueprint.json` | Publishes the `text` (and optional `link`) a webhook receives to Bluesky and Threads, and answers with the post ID and status. Used by the [how-to](https://ampost.io/how-to/post-to-social-media-from-make?ref=github) |
| RSS to all platforms | `rss-to-all-platforms.blueprint.json` | Posts each new feed item (title and link) right away |
| Google Sheets schedule | `google-sheets-schedule.blueprint.json` | Schedules one post per new row, writes the post ID and status back |
| AI-written post with approval | `ai-post-with-approval.blueprint.json` and `ai-post-approve.blueprint.json` | OpenAI writes a draft and Gmail emails an approval link. The second scenario publishes the draft when you click the link |
| New YouTube upload cross-post | `youtube-upload-cross-post.blueprint.json` | Posts each new video of a channel with its link |

To import one: in Make, create a scenario, open the **...** menu, choose **Import Blueprint** and
pick the file. Then:

1. Pick a connection in each Google, OpenAI and YouTube module. App versions also need an Ampost
   connection.
2. Replace the placeholders in capitals. `YOUR_AMPOST_API_KEY` is only in the HTTP versions: paste
   your key after `Bearer `, or better, keep it in a
   Make keychain and use the HTTP module's "API key" authentication. Fill in your feed URL, spreadsheet, channel and email address.
3. The posts go to LinkedIn, Facebook, Threads, X, Bluesky, Telegram and Discord (the webhook
   scenario: Bluesky and Threads). Remove the platforms you have not connected, or add yours: in the HTTP version from `"platforms"` in the request body, in
   the app version from the Platforms field. Instagram, TikTok, YouTube and Pinterest need an
   image or a video.
4. Click **Run once** to test, then turn the scenario on.

The Google Sheets template reads the sheet `Posts`. Its columns are: A Text, B Publish at (ISO
8601 with a time zone, such as `2026-12-01T09:00:00+01:00`), C Link URL (optional), D Post ID and
E Status. The scenario fills in D and E. Scheduling needs a paid Ampost plan.

For the AI templates, import `ai-post-approve` first and copy its webhook URL. Put that URL in
place of `YOUR_APPROVAL_WEBHOOK_URL` in the email of `ai-post-with-approval`. Choose a long random
`YOUR_APPROVAL_TOKEN` and use the same value in both scenarios. The approval scenario publishes only
when the token matches. To start a draft, send the first scenario's webhook a topic:
`curl -X POST <webhook URL> -H 'Content-Type: application/json' -d '{"topic": "our new feature"}'`.

If your app's name in Make isn't `ampost`, Make won't recognize the app versions' modules on
import. Replace the prefix first, for example
`sed -i 's/"ampost:/"ampost-a1b2c3:/' templates/app/*.json`.

## Develop

```sh
npm ci
npm test               # app files vs Make's schemas, IML, every module against openapi.json, templates
npm run test:smoke     # live: every route the app calls exists; with AMPOST_API_KEY, read-only modules run
npm run build:templates
```

- `test/lib/` holds a small IML evaluator and runner. They run the app's requests the way Make
  does (Base, temp, pagination, repeat, the webhook receiver) against a fake API, and check each
  request against `openapi.json`.
- `schemas/` holds Make's editor schemas (see `schemas/README.md`).
- `templates/` is generated: edit `scripts/templates.mjs`, then run `npm run build:templates`.
- `openapi.json` is the snapshot of the live API document. Refresh it with `npm run export:openapi`.

Things that are easy to get wrong when you edit the app:

- `makecomapp.json` lists all six component keys (`connection`, `webhook`, `module`, `rpc`,
  `function`, `endpoint`), empty ones included. Each file is at
  `<type>s/<kebab-name>/<kebab-name>.<code>.iml.json`, for example
  `modules/create-post/create-post.communication.iml.json`. Keep `origins` empty in commits: the VS
  Code extension adds your Make app there.
- In a communication, POST, PUT and PATCH need a `body`, and `headers` and `qs` must be objects. To
  pass all parameters, use the spread key inside the object, `"{{...}}": "{{omit(parameters, 'id')}}"`,
  not a whole-expression string.
- IML evaluates every function argument, `if()` included. `if(x, parseJSON(x), undefined)` fails
  when `x` is empty; write `parseJSON(ifempty(x, 'null'))`.
- A module's headers override Base's per header name. The connection's communication does not
  inherit Base at all.
- Make has no custom IML functions for this app (they need Make's approval), so a date inside an
  array can't be parsed: type it `text` in the interface. Wrap top-level dates as
  `if(x, parseDate(x), x)` so a null stays null.
- An empty `options.<platform>` for a platform the post doesn't target fails validation, so a
  platform's option fields must produce no key when they are empty.
- Scenario blueprints separate function arguments with `;` (`{{ifempty(1.text; null)}}`); the app's
  IML uses `,`.

## License

MIT, see `LICENSE`. `schemas/` is Make's, under its own license (`schemas/LICENSE.md`).
