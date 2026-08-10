// Bun.serve's documented ceiling for `idleTimeout`.
const BUN_MAX_IDLE_TIMEOUT_S = 255;

const XFF = 'x-forwarded-for';

/**
 * Environment variables the runtime reads, without the `envPrefix`. When an
 * `envPrefix` is configured, any *other* prefixed variable is a configuration
 * mistake and `validate_env` throws — same contract as adapter-node's `env.js`.
 */
export const SUPPORTED_ENV_VARS = new Set([
	'HOST',
	'PORT',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'SHUTDOWN_TIMEOUT',
	'CONNECTION_IDLE_TIMEOUT'
]);

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
		'SOCKET_PATH',
		'adapter-bun always listens on a TCP host/port; listening on a unix socket is not implemented'
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
	 * @param {string} name
	 * @param {string} fallback
	 * @returns {string}
	 */
	const read_env = (name, fallback) => env[`${env_prefix}${name}`] ?? fallback;

	const port = Number(read_env('PORT', '3000'));
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`${env_prefix}PORT must be an integer between 0 and 65535`);
	}

	const xff_depth = Number(read_env('XFF_DEPTH', '1'));
	if (!Number.isInteger(xff_depth) || xff_depth < 1) {
		throw new Error(`${env_prefix}XFF_DEPTH must be a positive integer`);
	}

	return {
		host: read_env('HOST', '0.0.0.0'),
		port,
		xff_depth,
		address_header: read_env('ADDRESS_HEADER', '').toLowerCase(),
		protocol_header: read_env('PROTOCOL_HEADER', '').toLowerCase(),
		host_header: read_env('HOST_HEADER', '').toLowerCase(),
		port_header: read_env('PORT_HEADER', '').toLowerCase(),
		body_size_limit: parse_as_bytes(
			read_env('BODY_SIZE_LIMIT', '512K'),
			`${env_prefix}BODY_SIZE_LIMIT`
		),
		// Bun.serve's own default is 10s, which closes any connection that goes
		// quiet for 10s — including an in-flight request whose handler hasn't
		// written bytes yet, and a slow server-sent-events stream. Default to `0`
		// (no timeout) so quiet long-lived responses are never cut off silently.
		connection_idle_timeout: parse_timeout(
			read_env('CONNECTION_IDLE_TIMEOUT', '0'),
			`${env_prefix}CONNECTION_IDLE_TIMEOUT`,
			BUN_MAX_IDLE_TIMEOUT_S
		),
		shutdown_timeout: parse_timeout(
			read_env('SHUTDOWN_TIMEOUT', '30'),
			`${env_prefix}SHUTDOWN_TIMEOUT`
		)
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
 * Runtime for adapter-bun. Invoked from the codegen-emitted entry.js with the
 * Server class, manifest, and asset maps already resolved to $bunfs paths.
 *
 * @param {Object} options
 * @param {new (manifest: import('@sveltejs/kit').SSRManifest) => import('@sveltejs/kit').Server} options.Server
 * @param {import('@sveltejs/kit').SSRManifest} options.manifest
 * @param {Set<string>} options.prerendered
 * @param {Record<string, string>} options.client_assets      URL path -> $bunfs file path
 * @param {Record<string, string>} options.prerendered_assets URL path -> $bunfs file path
 * @param {Record<string, string>} options.server_assets      manifest asset key -> $bunfs file path
 * @param {string} [options.origin]      `kit.paths.origin`, baked in at build time
 * @param {string} [options.env_prefix]
 * @returns {Promise<import('bun').Server<unknown>>}
 */
export async function start({
	Server,
	manifest,
	prerendered,
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
		xff_depth,
		address_header,
		protocol_header,
		host_header,
		port_header,
		body_size_limit,
		connection_idle_timeout,
		shutdown_timeout
	} = read_config(process.env, env_prefix);

	const server = new Server(manifest);

	await server.init({
		env: /** @type {Record<string, string>} */ (process.env),
		read: (file) => Bun.file(server_assets[file]).stream()
	});

	// Only hashed build output gets the immutable cache header — not e.g. version.json.
	const immutable_prefix = `/${manifest.appPath}/immutable/`;

	// Prerendered overrides client on key overlap.
	/** @type {Record<string, (request: Request) => Response>} */
	const routes = {};
	for (const [url_path, bunfs_path] of Object.entries(client_assets)) {
		routes[url_path] = make_asset_handler(bunfs_path, {
			type: mime_type(url_path, manifest.mimeTypes),
			cache_control: url_path.startsWith(immutable_prefix) ? IMMUTABLE_CACHE_CONTROL : undefined
		});
	}
	for (const [url_path, bunfs_path] of Object.entries(prerendered_assets)) {
		routes[url_path] = make_asset_handler(bunfs_path, {
			type: mime_type(url_path, manifest.mimeTypes)
		});
	}

	const bun_server = Bun.serve({
		hostname: host,
		port,
		routes,
		maxRequestBodySize: body_size_limit,
		idleTimeout: connection_idle_timeout,
		fetch: async (request, srv) => {
			try {
				const url = new URL(request.url);

				const effective_origin = resolve_origin(request, url, {
					origin,
					protocol_header,
					host_header,
					port_header
				});

				let final_url = url;
				let final_request = request;
				if (effective_origin && `${url.protocol}//${url.host}` !== effective_origin) {
					final_request = new Request(`${effective_origin}${url.pathname}${url.search}`, request);
					final_url = new URL(final_request.url);
				}

				let pathname = final_url.pathname;
				if (pathname.includes('%')) {
					try {
						pathname = decodeURIComponent(pathname);
					} catch (err) {
						process.stderr.write(`adapter-bun: failed to decode pathname '${pathname}': ${err}\n`);
					}
				}

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
		}
	});

	process.stderr.write(`Listening on http://${host}:${port}\n`);

	await new Promise((resolve) => {
		let stopping = false;
		const stop = async () => {
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
			resolve(undefined);
		};
		process.on('SIGTERM', stop);
		process.on('SIGINT', stop);
	});

	return bun_server;
}

/**
 * Resolve the origin the browser is seeing: the build-time `kit.paths.origin` if
 * configured, otherwise derived from the request and env-configured proxy headers.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} cfg
 * @param {string} [cfg.origin]          `kit.paths.origin`, baked in at build time
 * @param {string} cfg.protocol_header   lowercased, '' to disable
 * @param {string} cfg.host_header       lowercased, '' to disable
 * @param {string} cfg.port_header       lowercased, '' to disable
 * @returns {string | undefined}
 */
export function resolve_origin(
	request,
	url,
	{ origin, protocol_header, host_header, port_header }
) {
	if (origin) return origin;
	if (!protocol_header && !host_header && !port_header) return undefined;

	const headers = request.headers;

	let protocol = url.protocol.slice(0, -1);
	if (protocol_header) {
		const value = headers.get(protocol_header);
		if (value) {
			// prevent host-injection through the protocol header (RFC 7230 §5.5)
			if (value.includes(':')) {
				throw new Error(
					`The ${protocol_header} header specified '${value}' which is invalid because it includes \`:\`. It should only contain the protocol scheme (e.g. \`https\`)`
				);
			}
			protocol = value;
		}
	}

	const hostname = host_header ? headers.get(host_header) || url.hostname : url.hostname;

	let port = '';
	if (port_header) {
		const value = headers.get(port_header);
		if (value) {
			if (Number.isNaN(Number(value))) {
				throw new Error(
					`The ${port_header} header specified '${value}' which is an invalid port. The value should only contain the port number (e.g. 443)`
				);
			}
			port = value;
		}
	}

	return port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`;
}

/**
 * Content type for a served asset, taken from SvelteKit's manifest metadata so that
 * types SvelteKit knows about (e.g. `.ico`, `image/jxl`) are used rather than only
 * Bun's own extension mapping. Returns `undefined` when the manifest has no entry,
 * in which case `Bun.file(...).type` is used as the fallback.
 *
 * @param {string} url_path
 * @param {Record<string, string> | undefined} mime_types  `manifest.mimeTypes`
 * @returns {string | undefined}
 */
export function mime_type(url_path, mime_types) {
	const filename = url_path.slice(url_path.lastIndexOf('/') + 1);
	const dot = filename.lastIndexOf('.');
	if (dot === -1) return undefined;

	const type = mime_types?.[filename.slice(dot)];
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
 * Per-asset handler: GET, HEAD, OPTIONS, plus `Range: bytes=start-end` (206). Other methods → 405.
 *
 * @param {string} bunfs_path
 * @param {Object} [options]
 * @param {string} [options.type]           content type; defaults to Bun's extension mapping
 * @param {string} [options.cache_control]  `cache-control` header, if any
 * @returns {(request: Request) => Response}
 */
export function make_asset_handler(bunfs_path, { type: mime, cache_control } = {}) {
	const file = Bun.file(bunfs_path);
	const type = mime ?? file.type;
	const size = file.size;
	/** @type {Record<string, string>} */
	const extra_headers = cache_control ? { 'cache-control': cache_control } : {};

	return (request) => {
		const method = request.method;

		if (method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: { allow: 'GET, HEAD, OPTIONS' }
			});
		}

		if (method !== 'GET' && method !== 'HEAD') {
			return new Response(null, {
				status: 405,
				headers: { allow: 'GET, HEAD, OPTIONS' }
			});
		}

		const range = request.headers.get('range');
		if (range) {
			const match = /^bytes=(\d+)-(\d*)$/.exec(range);
			if (match) {
				const start = Number(match[1]);
				const end = match[2] ? Number(match[2]) : size - 1;
				if (start <= end && end < size) {
					const body = method === 'HEAD' ? null : file.slice(start, end + 1);
					return new Response(body, {
						status: 206,
						headers: {
							...extra_headers,
							'content-type': type,
							'content-range': `bytes ${start}-${end}/${size}`,
							'content-length': String(end - start + 1),
							'accept-ranges': 'bytes'
						}
					});
				}
			}
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${size}` }
			});
		}

		const body = method === 'HEAD' ? null : file;
		return new Response(body, {
			headers: {
				...extra_headers,
				'content-type': type,
				'content-length': String(size),
				'accept-ranges': 'bytes'
			}
		});
	};
}
