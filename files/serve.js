// Bun.serve's documented ceiling for `idleTimeout`.
const BUN_MAX_IDLE_TIMEOUT_S = 255;

const XFF = 'x-forwarded-for';

// Hashed `/{appPath}/immutable/*` files never change, so they can be cached forever.
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';

/**
 * Environment variables the runtime reads (without the `envPrefix`). When an
 * `envPrefix` is configured, any other prefixed variable is a configuration
 * mistake and `validate_env` throws — same contract as adapter-node's `env.js`.
 */
export const SUPPORTED_ENV_VARS = new Set([
	'HOST',
	'PORT',
	'ORIGIN',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'IDLE_TIMEOUT',
	'SHUTDOWN_TIMEOUT'
]);

/**
 * Fail fast on prefixed variables the runtime does not understand — a mistyped
 * or colliding `envPrefix` would otherwise be silently ignored.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} env_prefix
 */
export function validate_env(env, env_prefix) {
	if (!env_prefix) return;

	for (const name in env) {
		if (!name.startsWith(env_prefix)) continue;
		if (!SUPPORTED_ENV_VARS.has(name.slice(env_prefix.length))) {
			throw new Error(
				`You should change envPrefix (${env_prefix}) to avoid conflicts with existing environment variables — unexpectedly saw ${name}`
			);
		}
	}
}

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
	env_prefix = ''
}) {
	validate_env(process.env, env_prefix);

	const server = new Server(manifest);

	await server.init({
		env: /** @type {Record<string, string>} */ (process.env),
		read: (file) => Bun.file(server_assets[file]).stream()
	});

	/**
	 * @param {string} name
	 * @param {string} fallback
	 * @returns {string}
	 */
	const read_env = (name, fallback) => process.env[`${env_prefix}${name}`] ?? fallback;

	/** @param {string} name */
	const read_opt_env = (name) => process.env[`${env_prefix}${name}`];

	const host = read_env('HOST', '0.0.0.0');
	const port = Number(read_env('PORT', '3000'));
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`${env_prefix}PORT must be an integer between 0 and 65535`);
	}

	const origin_env = parse_origin(read_opt_env('ORIGIN'), `${env_prefix}ORIGIN`);
	const xff_depth = Number(read_env('XFF_DEPTH', '1'));
	if (!Number.isInteger(xff_depth) || xff_depth < 1) {
		throw new Error(`${env_prefix}XFF_DEPTH must be a positive integer`);
	}
	const address_header = read_env('ADDRESS_HEADER', '').toLowerCase();
	const protocol_header = read_env('PROTOCOL_HEADER', '').toLowerCase();
	const host_header = read_env('HOST_HEADER', '').toLowerCase();
	const port_header = read_env('PORT_HEADER', '').toLowerCase();
	const body_size_limit = parse_as_bytes(
		read_env('BODY_SIZE_LIMIT', '512K'),
		`${env_prefix}BODY_SIZE_LIMIT`
	);
	const raw_idle_timeout = Number(read_env('IDLE_TIMEOUT', '10'));
	if (!Number.isFinite(raw_idle_timeout) || raw_idle_timeout < 0) {
		throw new Error(`${env_prefix}IDLE_TIMEOUT must be a non-negative number`);
	}
	// Bun.serve clamps at BUN_MAX_IDLE_TIMEOUT_S; apply ceiling to avoid a runtime error.
	const idle_timeout = Math.min(BUN_MAX_IDLE_TIMEOUT_S, raw_idle_timeout);
	const shutdown_timeout = Number(read_env('SHUTDOWN_TIMEOUT', '30'));
	if (!Number.isFinite(shutdown_timeout) || shutdown_timeout < 0) {
		throw new Error(`${env_prefix}SHUTDOWN_TIMEOUT must be a non-negative number`);
	}

	// Only hashed build output gets the immutable cache header — not e.g. version.json.
	const immutable_prefix = `/${manifest.appPath}/immutable/`;

	/** @type {Record<string, (request: Request) => Response>} */
	const routes = {};
	for (const [url_path, bunfs_path] of Object.entries(client_assets)) {
		const cache_control = url_path.startsWith(immutable_prefix)
			? IMMUTABLE_CACHE_CONTROL
			: undefined;
		routes[url_path] = make_asset_handler(bunfs_path, cache_control);
	}
	// Prerendered overrides client on key overlap.
	for (const [url_path, bunfs_path] of Object.entries(prerendered_assets)) {
		routes[url_path] = make_asset_handler(bunfs_path);
	}

	const bun_server = Bun.serve({
		hostname: host,
		port,
		routes,
		maxRequestBodySize: body_size_limit,
		idleTimeout: idle_timeout,
		fetch: async (request, srv) => {
			try {
				const url = new URL(request.url);

				let effective_origin;
				try {
					effective_origin = resolve_origin(request, url, {
						origin_env,
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
					let location = pathname.at(-1) === '/' ? pathname.slice(0, -1) : pathname + '/';
					if (prerendered.has(location)) {
						if (final_url.search) location += final_url.search;
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
					// `IDLE_TIMEOUT`, which would have Bun close the connection
					// mid-response. Opt this connection out.
					if (idle_timeout > 0) srv.timeout(request, 0);
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

	// the bound address, not the requested one — e.g. the real port for `PORT=0`
	process.stderr.write(`Listening on ${bun_server.url.origin}\n`);

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
 * @param {string | undefined} value
 * @param {string} env_name
 * @returns {string | undefined}
 */
export function parse_origin(value, env_name) {
	if (value === undefined) return undefined;

	const trimmed = value.trim();
	let url;
	try {
		url = new URL(trimmed);
	} catch (cause) {
		throw new Error(
			`Invalid ${env_name}: '${trimmed}'. Must be a valid URL with http:// or https:// protocol. ` +
				`For example: 'http://localhost:3000'`,
			{ cause }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Invalid ${env_name}: '${trimmed}'. Only http:// and https:// are supported.`);
	}
	return url.origin;
}

/**
 * Resolve the origin the browser is seeing, honoring env-configured proxy headers.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} cfg
 * @param {string} [cfg.origin_env]
 * @param {string} cfg.protocol_header   lowercased, '' to disable
 * @param {string} cfg.host_header       lowercased, '' to disable
 * @param {string} cfg.port_header       lowercased, '' to disable
 * @returns {string | undefined}
 */
export function resolve_origin(
	request,
	url,
	{ origin_env, protocol_header, host_header, port_header }
) {
	if (origin_env) return origin_env;
	if (!protocol_header && !host_header && !port_header) return undefined;

	const headers = request.headers;

	const raw_protocol = protocol_header
		? normalise_header(protocol_header, headers.get(protocol_header))
		: undefined;
	const protocol = raw_protocol ? decodeURIComponent(raw_protocol) : url.protocol.slice(0, -1);
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
 * @param {string} [cache_control]  sent with every 200/206 response when set
 * @returns {(request: Request) => Response}
 */
export function make_asset_handler(bunfs_path, cache_control) {
	const file = Bun.file(bunfs_path);
	const type = file.type;
	const size = file.size;
	/** @type {Record<string, string>} */
	const cache_headers = cache_control ? { 'cache-control': cache_control } : {};

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
							...cache_headers,
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
				...cache_headers,
				'content-type': type,
				'content-length': String(size),
				'accept-ranges': 'bytes'
			}
		});
	};
}
