// MARK: - Injected by SvelteKit
import { Server } from "SERVER";

const manifest = MANIFEST;

/** @type {import('./index.d.ts').Prerendered} */
const prerendered = PRERENDERED;
/** @type {string} */
const app_path = APP_PATH;

// MARK: - Prepare static routes
const dir = `${import.meta.dir}/client`;

/** @type {Record<string, Response>} */
const static_routes = {};

for (const [name, { status, location }] of prerendered.redirects) {
	const file = Bun.file(`${dir}${name}.html`);
	static_routes[name] = new Response(await file.bytes(), { status, headers: { location, "content-type": file.type } });
}

for (const [path, { type }] of prerendered.assets) {
	const file = Bun.file(`${dir}${path}`);
	if (type !== file.type) {
		console.warn("[svelte-kit-bun]", `Asset ${path} has different type (${type}) than expected (${file.type})`);
	}
	static_routes[path] = new Response(await file.bytes(), { headers: { "content-type": type } });
}

for (const [path, { file }] of prerendered.pages) {
	const page = Bun.file(`${dir}/${file}`);
	static_routes[path] = new Response(await page.bytes(), { headers: { "content-type": page.type } });
}

const app_path_glob = new Bun.Glob(`${app_path}/**`);
for await (const pathname of app_path_glob.scan(`${dir}`)) {
	const file = Bun.file(`${dir}/${pathname}`);
	const immutable = pathname.startsWith(`${app_path}/immutable/`);

	/** @type {Record<string, string>} */
	const headers = { "content-type": file.type };
	if (immutable) headers["cache-control"] = "public, max-age=31536000, immutable";

	static_routes[`/${pathname}`] = new Response(await file.bytes(), { headers });
}

for (const path of manifest.assets) {
	const file = Bun.file(`${dir}/${path}`);
	static_routes[`/${path}`] = new Response(await file.bytes(), { headers: { "content-type": file.type } });
}

// MARK: - Initialize server

/** @type {import('./index.d.ts').Server} */
const server = new Server(manifest);

await server.init({
	//@ts-expect-error - Bun.env is NodeJS.ProcessEnv which works, but TS doesn't know that
	env: Bun.env,
	read: (file) => Bun.file(`${dir}/${file}`).stream(),
});

// MARK: - Serve

Bun.serve({
	development: false,
	static: static_routes,
	async fetch(req, _server) {
		return server.respond(req, {
			getClientAddress() {
				const address = _server.requestIP(req);
				let ret = "";
				if (address?.address) {
					if (address.family === "IPv4") ret += address.address;
					if (address.family === "IPv6") ret += `[${address.address}]`;
				}
				if (address?.port) ret += `:${address.port}`;
				return ret;
			},
			platform: {
				server: _server,
			},
		});
	},
});
