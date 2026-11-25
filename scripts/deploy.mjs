#!/usr/bin/env node
// Deploys this app to a Make account through Make's API, without the VS Code extension.
//
//   MAKE_API_TOKEN=... node scripts/deploy.mjs              # first run: creates the app, prints its name
//   MAKE_API_TOKEN=... MAKE_APP=ampost-xxxx node scripts/deploy.mjs
//
// MAKE_ZONE defaults to eu1.make.com. The token needs the sdk-apps:read and sdk-apps:write scopes.
// Every run uploads every file again; components are matched by label (connections, webhooks) or
// name (modules, RPCs), so a run never duplicates them. Nothing is written to makecomapp.json.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MAKE_API_TOKEN;
const zone = process.env.MAKE_ZONE || 'eu1.make.com';
let app = process.env.MAKE_APP;
const version = 1;
if (!token) throw new Error('Set MAKE_API_TOKEN (scopes sdk-apps:read, sdk-apps:write).');

const api = `https://${zone}/api/v2`;
const manifest = JSON.parse(await readFile(join(root, 'makecomapp.json'), 'utf8'));
const text = (path) => readFile(join(root, path), 'utf8');

async function call(method, path, body, type = 'application/json') {
	const headers = { authorization: `Token ${token}` };
	if (body !== undefined) headers['content-type'] = type;
	const payload = body === undefined || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	const res = await fetch(api + path, { method, headers, body: payload });
	const raw = await res.text();
	let json;
	try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${raw.slice(0, 500)}`);
	return json;
}

// Sections are sent as the file's text (JSONC), so the files stay exactly as in git.
const section = async (path, file) => file && call('PUT', path, await text(file), 'application/jsonc');

const APP_DESCRIPTION = 'Publish, schedule and track social media posts on 11 platforms with one API.';

if (!app) {
	const created = await call('POST', '/sdk/apps', {
		name: 'ampost',
		label: 'Ampost',
		description: APP_DESCRIPTION,
		theme: '#006E3D',
		language: 'en',
	});
	app = created.app.name;
	console.log(`Created app ${app}. Set MAKE_APP=${app} for later runs.`);
}
const appPath = `/sdk/apps/${app}/${version}`;

// General
await call('PATCH', appPath, { label: 'Ampost', description: APP_DESCRIPTION, theme: '#006E3D' });
await section(`${appPath}/base`, manifest.generalCodeFiles.base);
if (manifest.generalCodeFiles.common) await section(`${appPath}/common`, manifest.generalCodeFiles.common);
await call('PUT', `${appPath}/readme`, await text(manifest.generalCodeFiles.readme), 'text/markdown');
await call('PUT', `${appPath}/icon`, await readFile(join(root, 'assets/icon.png')), 'image/png');
console.log('general: base, readme, icon');

// Connections: Make names them itself, so match by label.
const connectionNames = {};
const existingConnections = (await call('GET', `/sdk/apps/${app}/connections`)).appConnections ?? [];
for (const [id, c] of Object.entries(manifest.components.connection)) {
	let name = existingConnections.find((x) => x.label === c.label)?.name;
	if (!name) name = (await call('POST', `/sdk/apps/${app}/connections`, { type: c.connectionType, label: c.label })).appConnection.name;
	connectionNames[id] = name;
	await section(`/sdk/apps/connections/${name}/api`, c.codeFiles.communication);
	await section(`/sdk/apps/connections/${name}/parameters`, c.codeFiles.params);
	console.log(`connection ${id} -> ${name}`);
}

// Webhooks: also named by Make.
const webhookNames = {};
const existingWebhooks = (await call('GET', `/sdk/apps/${app}/webhooks`)).appWebhooks ?? [];
for (const [id, w] of Object.entries(manifest.components.webhook)) {
	let name = existingWebhooks.find((x) => x.label === w.label)?.name;
	if (!name) {
		name = (await call('POST', `/sdk/apps/${app}/webhooks`, {
			type: w.webhookType,
			label: w.label,
			connection: connectionNames[w.connection],
		})).appWebhook.name;
	}
	webhookNames[id] = name;
	const files = { api: 'communication', parameters: 'params', attach: 'attach', detach: 'detach', update: 'update', scope: 'requiredScope' };
	for (const [s, key] of Object.entries(files)) await section(`/sdk/apps/webhooks/${name}/${s}`, w.codeFiles[key]);
	console.log(`webhook ${id} -> ${name}`);
}

// RPCs keep our names: the modules call them as rpc://<name>.
const existingRpcs = new Set(((await call('GET', `${appPath}/rpcs`)).appRpcs ?? []).map((x) => x.name));
for (const [name, r] of Object.entries(manifest.components.rpc)) {
	if (!existingRpcs.has(name)) await call('POST', `${appPath}/rpcs`, { name, label: r.label, connection: connectionNames[r.connection] });
	else await call('PATCH', `${appPath}/rpcs/${name}`, { label: r.label, connection: connectionNames[r.connection] });
	await section(`${appPath}/rpcs/${name}/api`, r.codeFiles.communication);
	await section(`${appPath}/rpcs/${name}/parameters`, r.codeFiles.params);
	console.log(`rpc ${name}`);
}

// Modules keep our names: groups.json and the templates refer to them.
const TYPE_IDS = { trigger: 1, action: 4, search: 9, instant_trigger: 10, responder: 11, universal: 12 };
const existingModules = new Set(((await call('GET', `${appPath}/modules`)).appModules ?? []).map((x) => x.name));
for (const [name, m] of Object.entries(manifest.components.module)) {
	const meta = { label: m.label, description: m.description, connection: connectionNames[m.connection] ?? null };
	if (!existingModules.has(name)) {
		await call('POST', `${appPath}/modules`, {
			name,
			typeId: TYPE_IDS[m.moduleType],
			...meta,
			...(m.actionCrud ? { crud: m.actionCrud } : {}),
			...(m.webhook ? { webhook: webhookNames[m.webhook] } : {}),
			moduleInitMode: 'blank',
		});
	} else {
		await call('PATCH', `${appPath}/modules/${name}`, meta);
	}
	const files = { api: 'communication', parameters: 'staticParams', expect: 'mappableParams', interface: 'interface', samples: 'samples', scope: 'scope' };
	for (const [s, key] of Object.entries(files)) {
		// Instant triggers have no api section of their own: the webhook receives.
		await section(`${appPath}/modules/${name}/${s}`, m.codeFiles[key]);
	}
	// Visible in the module list (the review needs it). The app itself stays private until published.
	await call('POST', `${appPath}/modules/${name}/public`);
	console.log(`module ${name}`);
}

// Groups name modules, so they go last.
await section(`${appPath}/groups`, manifest.generalCodeFiles.groups);
console.log('groups');

console.log(`Done: https://${zone}/apps?tab=myapps -> ${app}`);
