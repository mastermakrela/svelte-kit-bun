import { rmSync, statSync } from 'node:fs';

// Bun.serve's documented ceiling for `idleTimeout`.
const BUN_MAX_IDLE_TIMEOUT_S = 255;

const XFF = 'x-forwarded-for';

/**
 * Environment variables the runtime reads (without the `envPrefix`), mapped to
 * their defaults.
 */
const ENV_DEFAULTS = {
	HOST: '0.0.0.0',
	PORT: '3000',
	// when set, `start()` binds to this unix socket instead of host/port
	SOCKET_PATH: '',
	XFF_DEPTH: '1',
	ADDRESS_HEADER: '',
	PROTOCOL_HEADER: '',
	HOST_HEADER: '',
	PORT_HEADER: '',
	BODY_SIZE_LIMIT: '512K',
	SHUTDOWN_TIMEOUT: '30',
	// Bun.serve's own default is 10s, which closes any connection that goes
	// quiet for 10s — including an in-flight request whose handler hasn't
	// written bytes yet, and a slow server-sent-events stream. Default to `0`
	// (no timeout) so quiet long-lived responses are never cut off silently.
	CONNECTION_IDLE_TIMEOUT: '0'
};

/**
 * When an `envPrefix` is configured, any prefixed variable not in this set is a
 * configuration mistake and `validate_env` throws — same contract as
 * adapter-node's `env.js`.
 */
export const SUPPORTED_ENV_VARS = new Set(Object.keys(ENV_DEFAULTS));

/**
 * adapter-node variables that have no counterpart here, mapped to the reason.
 * They are rejected (with an `envPrefix`) or warned about (without one) rather
 * than silently ignored, and rather than quietly repurposed for something that
 * happens to share a name.
 */
export const UNSUPPORTED_ENV_VARS = new Map([
	[
		'IDLE_TIMEOUT',
		"in adapter-node this shuts the process down after a period with no requests, which only applies under systemd socket activation — a feature adapter-bun doesn't implement. For Bun.serve's per-connection idle timeout use CONNECTION_IDLE_TIMEOUT"
	],
	[
		'KEEP_ALIVE_TIMEOUT',
		'Bun.serve has no separate keep-alive timeout; CONNECTION_IDLE_TIMEOUT covers idle connections'
	],
	[
		'HEADERS_TIMEOUT',
		'Bun.serve has no separate headers timeout; CONNECTION_IDLE_TIMEOUT covers connections that stop sending data'
	],
	['LISTEN_PID', 'socket activation is not supported'],
	['LISTEN_FDS', 'socket activation is not supported']
]);

/**
 * Fail fast on prefixed variables the runtime does not understand (a mistyped or
 * colliding `envPrefix` would otherwise be silently ignored), and on
 * adapter-node-only variables that would otherwise look like they did something.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} env_prefix
 * @param {(message: string) => void} warn
 */
export function validate_env(env, env_prefix, warn) {
	for (const [name, reason] of UNSUPPORTED_ENV_VARS) {
		const prefixed = `${env_prefix}${name}`;
		if (env[prefixed] === undefined) continue;

		const message = `${prefixed} is not supported by @sveltejs/adapter-bun: ${reason}`;
		// Without a prefix the variable may well belong to something else in the
		// environment, so warn rather than refusing to boot.
		if (env_prefix) throw new Error(message);
		warn(`${message}. It is being ignored`);
	}

	if (!env_prefix) return;

	for (const name in env) {
		if (!name.startsWith(env_prefix)) continue;
		const unprefixed = name.slice(env_prefix.length);
		if (!SUPPORTED_ENV_VARS.has(unprefixed)) {
			throw new Error(
				`You should change envPrefix (${env_prefix}) to avoid conflicts with existing environment variables — unexpectedly saw ${name}`
			);
		}
	}
}

/**
 * Read and validate the runtime configuration from the environment.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} [env_prefix]
 * @param {(message: string) => void} [warn]
 */
export function read_config(
	env,
	env_prefix = '',
	warn = (message) => process.stderr.write(`adapter-bun: ${message}\n`)
) {
	validate_env(env, env_prefix, warn);

	/**
	 * @param {keyof typeof ENV_DEFAULTS} name
	 * @returns {string}
	 */
	const read_env = (name) => env[`${env_prefix}${name}`] ?? ENV_DEFAULTS[name];

	const port = Number(read_env('PORT'));
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`${env_prefix}PORT must be an integer between 0 and 65535`);
	}

	const xff_depth = Number(read_env('XFF_DEPTH'));
	if (!Number.isInteger(xff_depth) || xff_depth < 1) {
		throw new Error(`${env_prefix}XFF_DEPTH must be a positive integer`);
	}

	return {
		host: read_env('HOST'),
		port,
		socket_path: read_env('SOCKET_PATH'),
		xff_depth,
		address_header: read_env('ADDRESS_HEADER').toLowerCase(),
		protocol_header: read_env('PROTOCOL_HEADER').toLowerCase(),
		host_header: read_env('HOST_HEADER').toLowerCase(),
		port_header: read_env('PORT_HEADER').toLowerCase(),
		body_size_limit: parse_as_bytes(read_env('BODY_SIZE_LIMIT'), `${env_prefix}BODY_SIZE_LIMIT`),
		connection_idle_timeout: parse_timeout(
			read_env('CONNECTION_IDLE_TIMEOUT'),
			`${env_prefix}CONNECTION_IDLE_TIMEOUT`,
			BUN_MAX_IDLE_TIMEOUT_S
		),
		shutdown_timeout: parse_timeout(read_env('SHUTDOWN_TIMEOUT'), `${env_prefix}SHUTDOWN_TIMEOUT`)
	};
}

/**
 * Parse a timeout in whole seconds, mirroring adapter-node's `timeout_env`.
 *
 * @param {string} value
 * @param {string} env_name
 * @param {number} [max]
 * @returns {number}
 */
export function parse_timeout(value, env_name, max) {
	if (!/^\d+$/.test(value)) {
		throw new Error(
			`${env_name} must be a non-negative integer number of seconds (got '${value}')`
		);
	}

	const seconds = Number(value);
	if (max !== undefined && seconds > max) {
		throw new Error(`${env_name} must be at most ${max} seconds (got '${value}')`);
	}

	return seconds;
}

// Hashed `/{appPath}/immutable/*` files never change, so they can be cached forever.
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';

/**
 * @typedef {Object} CompressedVariant
 * @property {string} file  $bunfs path
 * @property {number} size
 */

/**
 * @typedef {Object} BuiltAsset
 * @property {string} file  $bunfs path
 * @property {number} size
 * @property {string} etag  bare sha256/base64url content hash, computed at build time
 * @property {CompressedVariant} [br]
 * @property {CompressedVariant} [gz]
 */

/**
 * @typedef {Object} Asset
 * @property {string} file
 * @property {number} size
 * @property {string} etag
 * @property {string} [type]
 * @property {string} [cache_control]
 * @property {CompressedVariant} [br]
 * @property {CompressedVariant} [gz]
 */

/**
 * Parse `Accept-Encoding` and pick the preferred variant that exists, mirroring
 * upstream adapter-node's `negotiate`: q-values (default 1), `*` as a fallback
 * weight, gzip preferred over br only when its q is strictly higher, and q=0
 * refusing a coding outright.
 *
 * @param {string | null} header
 * @param {{ br?: unknown, gz?: unknown }} asset
 * @returns {'br' | 'gz' | undefined}
 */
export function negotiate(header, asset) {
	if (!header || !(asset.br || asset.gz)) return undefined;

	/** @type {Map<string, number>} */
	const weights = new Map();

	for (const part of header.toLowerCase().split(',')) {
		const [coding, ...params] = part.split(';');
		let weight = 1;

		for (const param of params) {
			const [name, value] = param.split('=');
			if (name.trim() === 'q') weight = parseFloat(value) || 0;
		}

		weights.set(coding.trim(), weight);
	}

	/** @param {string} coding */
	const weight = (coding) => weights.get(coding) ?? weights.get('*') ?? 0;

	const br = asset.br ? weight('br') : 0;
	const gzip = asset.gz ? weight('gzip') : 0;

	if (gzip > br) return 'gz';
	if (br > 0) return 'br';
	return undefined;
}

/**
 * Whether an `If-None-Match` (or `If-Range`, compared to a single etag) header
 * value matches `etag`, using weak comparison — an exact match after stripping a
 * leading `W/`, or the wildcard `*`. Mirrors upstream adapter-node's `etag_matches`.
 *
 * @param {string | null} header
 * @param {string} etag  already quoted, e.g. `"abc123"`
 * @returns {boolean}
 */
export function etag_matches(header, etag) {
	if (!header) return false;
	if (header.trim() === '*') return true;
	return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/**
 * One lookup for every request, decided at boot: client assets — including the
 * clean-URL aliases `create_asset_table` derives from `.html` files under
 * `static/` (`/foo` and `/foo/` resolve to `foo.html`, or to `foo/index.html`
 * when only that exists; an exact file key always wins over an alias, and when
 * both forms exist `foo.html` claims the aliases because it sorts first) — plus
 * prerendered assets, matched only at their exact path. Client assets win a key
 * collision, mirroring upstream adapter-node's `create_file_map`. The
 * non-canonical trailing-slash form of a prerendered path is handled separately
 * in `fetch` (see the `prerendered` Set), not aliased here.
 *
 * @param {Object} opts
 * @param {string} opts.app_path
 * @param {Record<string, string>} opts.mime_types
 * @param {Record<string, BuiltAsset>} opts.client_assets
 * @param {Record<string, BuiltAsset>} opts.prerendered_assets
 * @returns {Map<string, Asset>}
 */
export function create_file_map({ app_path, mime_types, client_assets, prerendered_assets }) {
	// Only hashed build output gets the immutable cache header — not e.g. version.json.
	const immutable_prefix = `/${app_path}/immutable/`;

	/**
	 * @param {string} key
	 * @param {BuiltAsset} raw
	 * @returns {Asset}
	 */
	const to_asset = (key, raw) => ({
		...raw,
		type: mime_type(key, mime_types),
		cache_control: key.startsWith(immutable_prefix) ? IMMUTABLE_CACHE_CONTROL : undefined
	});

	/** @type {Map<string, Asset>} */
	const files = new Map();

	const client_keys = Object.keys(client_assets).sort();
	for (const key of client_keys) files.set(key, to_asset(key, client_assets[key]));

	for (const key of client_keys) {
		if (!key.endsWith('.html')) continue;
		const asset = /** @type {Asset} */ (files.get(key));

		const is_index = key.endsWith('/index.html');
		const with_slash = is_index ? key.slice(0, -'index.html'.length) : `${key.slice(0, -5)}/`;
		if (!files.has(with_slash)) files.set(with_slash, asset);

		const without_slash = with_slash.slice(0, -1);
		if (without_slash && !files.has(without_slash)) files.set(without_slash, asset);
	}

	for (const [key, raw] of Object.entries(prerendered_assets)) {
		if (!files.has(key)) files.set(key, to_asset(key, raw));
	}

	return files;
}

/**
 * Remove a stale unix socket file before binding to it — `Bun.serve` refuses to
 * listen over an existing path otherwise. Mirrors upstream adapter-node's own
 * guard, including its limitation: a live socket's `size` also reports `0`
 * (sockets have no content), so this can't actually distinguish "nothing is
 * listening here" from "something is" — it only clears a plain empty file left
 * behind by, say, an unclean shutdown. Anything else at the path (non-empty, or
 * the stat call failing outright) is left alone; `Bun.serve` surfaces the
 * resulting bind failure itself.
 *
 * @param {string} path
 */
export function remove_stale_socket(path) {
	try {
		if (statSync(path).size === 0) rmSync(path);
	} catch {
		// ignore: no file at path, or it's otherwise inaccessible
	}
}

/**
 * Runtime for adapter-bun. Invoked from the codegen-emitted entry.js with the
 * SvelteKit server instance, build metadata, and asset maps already resolved to
 * $bunfs paths.
 *
 * @param {Object} options
 * @param {import('@sveltejs/kit').Server} options.server
 * @param {Set<string>} options.prerendered
 * @param {string} options.app_path   `builder.getAppPath()`, e.g. `_app` or `base/_app`
 * @param {Record<string, string>} options.mime_types  `builder.mimeTypes`
 * @param {Record<string, BuiltAsset>} options.client_assets      URL path -> build-time asset data
 * @param {Record<string, BuiltAsset>} options.prerendered_assets URL path -> build-time asset data
 * @param {Record<string, string>} options.server_assets      manifest asset key -> $bunfs file path
 * @param {string} [options.origin]      `paths.origin`, baked in at build time
 * @param {string} [options.env_prefix]
 * @returns {Promise<import('bun').Server<unknown>>}
 */
export async function start({
	server,
	prerendered,
	app_path,
	mime_types,
	client_assets,
	prerendered_assets,
	server_assets,
	origin,
	env_prefix = ''
}) {
	// read the environment before starting the app: an unusable configuration
	// should fail immediately, not after `server.init()` ran side effects
	const {
		host,
		port,
		socket_path,
		xff_depth,
		address_header,
		protocol_header,
		host_header,
		port_header,
		body_size_limit,
		connection_idle_timeout,
		shutdown_timeout
	} = read_config(process.env, env_prefix);

	await server.init({
		env: /** @type {Record<string, string>} */ (process.env),
		read: (file) => Bun.file(server_assets[file]).stream()
	});

	const files = create_file_map({ app_path, mime_types, client_assets, prerendered_assets });
	/** @type {Map<string, (request: Request) => Response>} */
	const static_handlers = new Map();
	for (const [key, asset] of files) static_handlers.set(key, make_asset_handler(asset));

	/** @type {(request: Request, srv: import('bun').Server<unknown>) => Promise<Response>} */
	const fetch = async (request, srv) => {
		try {
			const url = new URL(request.url);
			const pathname = decode_pathname(url.pathname);

			// Static assets are a closed set decided at boot — served before origin
			// resolution / SSR, same as upstream adapter-node's static middleware
			// running ahead of the SvelteKit handler.
			const static_handler = static_handlers.get(pathname);
			if (static_handler) return static_handler(request);

			let effective_origin;
			try {
				effective_origin = resolve_origin(request, url, {
					origin,
					protocol_header,
					host_header,
					port_header
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(`adapter-bun: Could not determine request origin: ${message}\n`);
				return new Response('Bad Request', { status: 400 });
			}

			let final_url = url;
			let final_request = request;
			if (`${url.protocol}//${url.host}` !== effective_origin) {
				final_request = new Request(`${effective_origin}${url.pathname}${url.search}`, request);
				final_url = new URL(final_request.url);
			}

			// `pathname` is unaffected by the origin swap above — only the
			// protocol/host of `final_url` differ from `url`.
			if (!prerendered.has(pathname)) {
				// remove or add trailing slash as appropriate
				const inverted = pathname.at(-1) === '/' ? pathname.slice(0, -1) : pathname + '/';
				if (prerendered.has(inverted)) {
					// a *relative* location survives a proxy that strips a mount prefix
					const location = relative_pathname(pathname, inverted) + final_url.search;
					return new Response(null, { status: 308, headers: { location } });
				}
			}

			const response = await server.respond(final_request, {
				platform: { server: srv },
				getClientAddress: () =>
					get_client_address(request, srv, address_header, xff_depth, env_prefix)
			});

			// Reverse proxies such as nginx buffer responses by default (ignoring
			// `cache-control`), which breaks streaming responses like server-sent events.
			// `X-Accel-Buffering: no` opts out of that buffering and is a no-op on proxies
			// that don't recognise it. See https://github.com/sveltejs/kit/issues/15790
			if (response.headers.get('content-type') === 'text/event-stream') {
				response.headers.set('x-accel-buffering', 'no');

				// A server-sent-events stream may stay quiet for longer than
				// `CONNECTION_IDLE_TIMEOUT` (SvelteKit's `query.live`, for instance,
				// only sends a keep-alive comment every 30s), which would have Bun
				// close the connection mid-response. Opt this connection out.
				if (connection_idle_timeout > 0) srv.timeout(request, 0);
			}

			return response;
		} catch (err) {
			process.stderr.write(
				`adapter-bun: unhandled error for ${request.method} ${request.url}: ${
					err instanceof Error ? (err.stack ?? err.message) : err
				}\n`
			);
			return new Response('Internal Server Error', { status: 500 });
		}
	};

	// Bun's types forbid `idleTimeout` next to `unix`, but the runtime honours it there
	// too (Bun 1.4.2: the 10s default cuts a quiet unix-socket request as well), so
	// dropping it would silently bring that default back for `SOCKET_PATH`.
	/** @type {Record<string, unknown>} */
	const listen = socket_path ? { unix: socket_path } : { hostname: host, port };
	if (socket_path) remove_stale_socket(socket_path);
	const bun_server = Bun.serve({
		...listen,
		maxRequestBodySize: body_size_limit,
		idleTimeout: connection_idle_timeout,
		fetch
	});

	process.stderr.write(`Listening on ${socket_path || `http://${host}:${port}`}\n`);

	await new Promise((resolve) => {
		let stopping = false;
		/** @param {'SIGTERM' | 'SIGINT'} signal */
		const stop = async (signal) => {
			if (stopping) return;
			stopping = true;
			process.removeListener('SIGTERM', stop);
			process.removeListener('SIGINT', stop);
			const graceful = bun_server.stop();
			const force = new Promise((r) => {
				const timer = setTimeout(() => {
					bun_server.stop(true);
					r(undefined);
				}, shutdown_timeout * 1000);
				// so the timer itself doesn't keep the loop alive
				timer.unref?.();
			});
			try {
				await Promise.race([graceful, force]);
			} catch (err) {
				process.stderr.write(`adapter-bun: error during shutdown: ${err}\n`);
			}
			// Mirrors upstream adapter-node: emitted once, after the server has
			// stopped accepting connections (gracefully or forced after
			// SHUTDOWN_TIMEOUT), so app code can use it to clean up — e.g. closing a
			// database connection. Upstream also emits this for its 'IDLE' reason
			// under systemd socket activation, which this adapter doesn't implement.
			process.emit('sveltekit:shutdown', signal);
			resolve(undefined);
		};
		process.on('SIGTERM', stop);
		process.on('SIGINT', stop);
	});

	return bun_server;
}

/**
 * Reject a proxy header (protocol/host/port) that carries more than one value, mirroring
 * upstream adapter-node's `normalise_header`. Node's `IncomingHttpHeaders` can hand back
 * an array for a repeated header; Bun's `Headers.get()` already joins repeats with `, ` so
 * there is no array form to check here — a comma inside one of these single-valued headers
 * is therefore treated as "multiple values" and rejected the same way. This does NOT apply
 * to `ADDRESS_HEADER`, which is legitimately comma-separated when it's `x-forwarded-for`
 * (see `get_client_address`).
 *
 * @param {string} name    lowercased header name, for the error message
 * @param {string | null} value
 * @returns {string | undefined}
 */
function normalise_header(name, value) {
	if (value === null) return undefined;
	if (value.includes(',')) {
		throw new Error(
			`Multiple values provided for ${name} header where only one expected: ${value}`
		);
	}
	return value;
}

/**
 * Resolve the origin the browser is seeing: the build-time `paths.origin` if configured,
 * otherwise always derived from the request, corrected by whichever proxy headers are
 * configured. Mirrors upstream adapter-node's `get_origin`, including defaulting the
 * protocol to `https` when `PROTOCOL_HEADER` is unset or absent from the request — an
 * unconfigured deployment is assumed to sit behind a TLS-terminating proxy rather than
 * assumed to be plain `http`.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} cfg
 * @param {string} [cfg.origin]          `paths.origin`, baked in at build time
 * @param {string} cfg.protocol_header   lowercased, '' to disable
 * @param {string} cfg.host_header       lowercased, '' to disable
 * @param {string} cfg.port_header       lowercased, '' to disable
 * @returns {string}
 */
export function resolve_origin(
	request,
	url,
	{ origin, protocol_header, host_header, port_header }
) {
	if (origin) return origin;

	const headers = request.headers;

	const raw_protocol = protocol_header
		? normalise_header(protocol_header, headers.get(protocol_header))
		: undefined;
	const protocol = decodeURIComponent(raw_protocol || 'https');
	// prevent host-injection through the protocol header (RFC 7230 §5.5)
	if (protocol.includes(':')) {
		throw new Error(
			`The ${protocol_header} header specified '${protocol}' which is invalid because it includes \`:\`. It should only contain the protocol scheme (e.g. \`https\`)`
		);
	}

	// `url.host` (not `url.hostname`) so the fallback carries a non-default port, same
	// as upstream falling back to the raw `host` header (which is `hostname[:port]`).
	const host = host_header
		? normalise_header(host_header, headers.get(host_header)) || url.host
		: url.host;
	if (!host) {
		const header_names = host_header ? `${host_header} or host` : 'host';
		throw new Error(
			`Could not determine host. The request must have a value provided by the ${header_names} header`
		);
	}

	let port = '';
	if (port_header) {
		const value = normalise_header(port_header, headers.get(port_header));
		if (value) {
			if (Number.isNaN(Number(value))) {
				throw new Error(
					`The ${port_header} header specified '${value}' which is an invalid port. The value should only contain the port number (e.g. 443)`
				);
			}
			port = value;
		}
	}

	return port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
}

/**
 * Decode a request pathname the way SvelteKit's router does: split on the literal `%25`
 * (a percent-encoded `%`) and `decodeURI` each piece separately, rather than decoding the
 * whole pathname in one pass. That keeps reserved characters like `%2F` encoded (`decodeURI`
 * already leaves them alone), and — because the split removes every `%25` *before*
 * `decodeURI` runs — a literal `%25` in the path stays `%25` instead of `decodeURI` turning
 * it into a bare `%`, while any other `%XX` escape in the surrounding pieces still decodes
 * normally. Mirrors `decode_pathname` in `@sveltejs/kit/src/utils/url.js` and upstream
 * adapter-node's `static.js#split_url`. A malformed `%` escape is left undecoded, same as
 * upstream.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function decode_pathname(pathname) {
	if (!pathname.includes('%')) return pathname;
	try {
		return pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return pathname;
	}
}

/**
 * Content type for a served asset, taken from SvelteKit's manifest metadata so that
 * types SvelteKit knows about (e.g. `.ico`, `image/jxl`) are used rather than only
 * Bun's own extension mapping. Returns `undefined` when the manifest has no entry,
 * in which case `Bun.file(...).type` is used as the fallback.
 *
 * @param {string} url_path
 * @param {Record<string, string>} mime_types  `builder.mimeTypes`
 * @returns {string | undefined}
 */
export function mime_type(url_path, mime_types) {
	const filename = url_path.slice(url_path.lastIndexOf('/') + 1);
	const dot = filename.lastIndexOf('.');
	if (dot === -1) return undefined;

	const type = mime_types[filename.slice(dot)];
	if (!type) return undefined;

	return type === 'text/html' ? 'text/html;charset=utf-8' : type;
}

/**
 * Relative reference from `from` to `to`, which must differ only by a trailing slash.
 * Mirrors adapter-node's helper so slash redirects keep working behind a proxy that
 * strips a mount prefix.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relative_pathname(from, to) {
	const segment = to.replace(/\/$/, '').split('/').at(-1);

	return from.endsWith('/') ? `../${segment}` : `${segment}/`;
}

/**
 * @param {Request} request
 * @param {import('bun').Server<unknown>} srv
 * @param {string} address_header  lowercased header name, '' to use socket IP
 * @param {number} xff_depth       used when header is x-forwarded-for (1 = rightmost)
 * @param {string} env_prefix      for error messages
 * @returns {string}
 */
export function get_client_address(request, srv, address_header, xff_depth, env_prefix) {
	if (!address_header) return srv.requestIP(request)?.address ?? '';

	const value = request.headers.get(address_header);
	if (value === null) {
		throw new Error(
			`Address header was specified with ${env_prefix}ADDRESS_HEADER=${address_header} but is absent from the request`
		);
	}

	if (address_header === XFF) {
		const addresses = value.split(',').map((a) => a.trim());
		if (xff_depth > addresses.length) {
			throw new Error(
				`${env_prefix}XFF_DEPTH is ${xff_depth}, but only found ${addresses.length} addresses`
			);
		}
		return addresses[addresses.length - xff_depth];
	}

	return value;
}

/**
 * Parse a byte size with optional K/M/G suffix (e.g. '512K', '10M').
 *
 * @param {string} value
 * @param {string} env_name
 * @returns {number}
 */
export function parse_as_bytes(value, env_name) {
	const multiplier =
		{
			K: 1024,
			M: 1024 * 1024,
			G: 1024 * 1024 * 1024
		}[value[value.length - 1]?.toUpperCase() ?? ''] ?? 1;
	const numeric = Number(multiplier !== 1 ? value.substring(0, value.length - 1) : value);
	if (!Number.isFinite(numeric) || numeric < 0) {
		throw new Error(
			`${env_name} must be a non-negative number, optionally suffixed with K, M, or G (got '${value}')`
		);
	}
	return numeric * multiplier;
}

/**
 * Handler for one static asset: GET/HEAD only (every other method, including
 * OPTIONS, gets 405), conditional requests via `ETag`/`If-None-Match`, and
 * `Range` requests exactly like upstream adapter-node's `serve_static` — `end`
 * beyond `size - 1` is clamped rather than rejected, `bytes=-N` is a suffix
 * range, an unbounded `bytes=` (neither bound given) is ignored and falls
 * through to a full response, and a stale `If-Range` validator gets the whole
 * current representation instead of the requested slice. When precompressed
 * variants (`br`/`gz`) are present, `Accept-Encoding` is negotiated per request
 * (mirroring upstream's `serve_static`): the chosen variant swaps in its own
 * file/size/etag (`"<hash>.<variant>"`) before any of the above logic runs, and
 * `Vary: Accept-Encoding` is added whenever a variant could have been chosen.
 *
 * @param {Asset} asset
 * @returns {(request: Request) => Response}
 */
export function make_asset_handler({
	file: bunfs_path,
	size,
	type,
	cache_control,
	etag: hash,
	br,
	gz
}) {
	const file = Bun.file(bunfs_path);
	const content_type = type ?? file.type;
	const etag = `"${hash}"`;
	const has_variants = Boolean(br || gz);
	const br_file = br ? Bun.file(br.file) : undefined;
	const gz_file = gz ? Bun.file(gz.file) : undefined;

	return (request) => {
		const method = request.method;

		if (method !== 'GET' && method !== 'HEAD') {
			return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
		}

		// negotiate before anything else: the chosen variant's file/size/etag drive
		// every subsequent decision (304, range math, content-encoding)
		let serve_file = file;
		let serve_size = size;
		let serve_etag = etag;
		/** @type {string | undefined} */
		let content_encoding;

		if (has_variants) {
			const variant = negotiate(request.headers.get('accept-encoding'), { br, gz });
			if (variant === 'br' && br && br_file) {
				serve_file = br_file;
				serve_size = br.size;
				serve_etag = `"${hash}.br"`;
				content_encoding = 'br';
			} else if (variant === 'gz' && gz && gz_file) {
				serve_file = gz_file;
				serve_size = gz.size;
				serve_etag = `"${hash}.gz"`;
				content_encoding = 'gzip';
			}
		}

		/** @type {Record<string, string>} */
		const base_headers = { etag: serve_etag };
		if (has_variants) base_headers.vary = 'Accept-Encoding';
		if (cache_control) base_headers['cache-control'] = cache_control;

		if (etag_matches(request.headers.get('if-none-match'), serve_etag)) {
			return new Response(null, { status: 304, headers: base_headers });
		}

		/** @type {Record<string, string>} */
		const headers = {
			...base_headers,
			'content-length': String(serve_size),
			'accept-ranges': 'bytes'
		};
		if (content_type) headers['content-type'] = content_type;
		if (content_encoding) headers['content-encoding'] = content_encoding;

		const range_header = request.headers.get('range');
		// a stale `If-Range` validator means the client's partial copy is of an older
		// representation, so it gets the whole current one instead of a range
		const if_range = request.headers.get('if-range');
		if (range_header && (!if_range || if_range === serve_etag)) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range_header);

			if (match && (match[1] || match[2])) {
				let start = match[1] ? Number(match[1]) : NaN;
				let end = match[2] ? Number(match[2]) : serve_size - 1;

				if (Number.isNaN(start)) {
					// suffix range: the last `end` bytes
					start = Math.max(serve_size - end, 0);
					end = serve_size - 1;
				} else {
					end = Math.min(end, serve_size - 1);
				}

				if (start >= serve_size || start > end) {
					return new Response(null, {
						status: 416,
						headers: { 'content-range': `bytes */${serve_size}` }
					});
				}

				headers['content-range'] = `bytes ${start}-${end}/${serve_size}`;
				headers['content-length'] = String(end - start + 1);
				const body = method === 'HEAD' ? null : serve_file.slice(start, end + 1);
				return new Response(body, { status: 206, headers });
			}
		}

		const body = method === 'HEAD' ? null : serve_file;
		return new Response(body, { headers });
	};
}
