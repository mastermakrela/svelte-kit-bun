// MARK: - Helpers
/**
 *  @param {string} path
 *  @param {string | undefined} type
 */
async function _file(path, type = undefined) {
	const file = Bun.file(path);
	if (type && file.type !== type) {
		console.warn("[svelte-kit-bun]", `Asset ${path} has different type (${file.type}) than declared in SvelteKit (${type})`);
	}
	return new Response(await file.bytes(), {
		headers: {
			"content-type": type ?? file.type,
		},
	});
}

/**
 * @param {string} path
 * @param {string} type
 */
async function _immutable(path, type) {
	const response = await _file(path, type);
	response.headers.set("cache-control", "public, max-age=31536000, immutable");
	return response;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {number} status
 */
async function _redirect(from, to, status) {
	const file = Bun.file(from);
	return new Response(await file.bytes(), {
		status,
		headers: {
			location: to,
			"content-type": file.type,
		},
	});
}

// MARK: - Static routes (i.e. prerendered and client files)

// prettier-ignore
IMPORTS

// prettier-ignore
/** @type {Record<`/${string}`, Response>} */
const static_routes = {
STATIC_ROUTES
};

// MARK: - Initialize server
import { Server } from "SERVER";

const manifest = MANIFEST;

/** @type {import('./index.d.ts').Server} */
const server = new Server(manifest);

await server.init({
	//@ts-expect-error - Bun.env is NodeJS.ProcessEnv which works, but TS doesn't know that
	env: Bun.env,
	// we assume we have all the files, because they are bundled during SVelteKit's compile step
	read: (file) => {
		const data = static_routes[`/${file}`].body;
		if (!data) {
			throw new Error(`[svelte-kit-bun] File ${file} not found during \`read\` call.`);
		}
		return data;
	},
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
