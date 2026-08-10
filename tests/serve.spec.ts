import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	get_client_address,
	make_asset_handler,
	mime_type,
	parse_as_bytes,
	parse_timeout,
	read_config,
	relative_pathname,
	resolve_origin,
	start,
	SUPPORTED_ENV_VARS,
	UNSUPPORTED_ENV_VARS,
	validate_env
} from '../files/serve.js';

describe('validate_env', () => {
	const noop = () => {};

	test('accepts every supported variable under a prefix', () => {
		const env: Record<string, string> = {};
		for (const name of SUPPORTED_ENV_VARS) env[`MY_APP_${name}`] = '1';
		expect(() => validate_env(env, 'MY_APP_', noop)).not.toThrow();
	});

	test('rejects an unexpected prefixed variable', () => {
		expect(() => validate_env({ MY_APP_SECRET: 'x' }, 'MY_APP_', noop)).toThrow(
			/You should change envPrefix \(MY_APP_\) to avoid conflicts.*unexpectedly saw MY_APP_SECRET/s
		);
	});

	test('ignores unprefixed variables when a prefix is configured', () => {
		expect(() =>
			validate_env({ SECRET: 'x', HOST: '0.0.0.0', IDLE_TIMEOUT: '5' }, 'MY_APP_', noop)
		).not.toThrow();
	});

	test('accepts anything when no prefix is configured', () => {
		expect(() => validate_env({ SECRET: 'x', PATH: '/usr/bin' }, '', noop)).not.toThrow();
	});

	test.each([...UNSUPPORTED_ENV_VARS.keys()])('rejects prefixed %s with an explanation', (name) => {
		expect(() => validate_env({ [`MY_APP_${name}`]: '1' }, 'MY_APP_', noop)).toThrow(
			new RegExp(`MY_APP_${name} is not supported by @sveltejs/adapter-bun`)
		);
	});

	test('the IDLE_TIMEOUT error points at the Bun equivalent', () => {
		expect(() => validate_env({ MY_APP_IDLE_TIMEOUT: '5' }, 'MY_APP_', noop)).toThrow(
			/CONNECTION_IDLE_TIMEOUT/
		);
	});

	test('unsupported variables only warn when there is no prefix', () => {
		const warnings: string[] = [];
		expect(() =>
			validate_env({ IDLE_TIMEOUT: '5', SOCKET_PATH: '/tmp/s' }, '', (m) => warnings.push(m))
		).not.toThrow();
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatch(/IDLE_TIMEOUT is not supported.*It is being ignored/s);
		expect(warnings[1]).toContain('SOCKET_PATH is not supported');
	});

	test('an unset (undefined) variable is not flagged', () => {
		const warnings: string[] = [];
		expect(() =>
			validate_env({ IDLE_TIMEOUT: undefined }, '', (m) => warnings.push(m))
		).not.toThrow();
		expect(warnings).toHaveLength(0);
	});
});

describe('read_config', () => {
	const noop = () => {};

	test('defaults', () => {
		expect(read_config({}, '', noop)).toEqual({
			host: '0.0.0.0',
			port: 3000,
			xff_depth: 1,
			address_header: '',
			protocol_header: '',
			host_header: '',
			port_header: '',
			body_size_limit: 512 * 1024,
			// 0 = no timeout: Bun's own default of 10s would cut quiet long-lived responses
			connection_idle_timeout: 0,
			shutdown_timeout: 30
		});
	});

	test('reads every value through the prefix and lowercases header names', () => {
		expect(
			read_config(
				{
					MY_APP_HOST: '127.0.0.1',
					MY_APP_PORT: '8080',
					MY_APP_XFF_DEPTH: '3',
					MY_APP_ADDRESS_HEADER: 'X-Forwarded-For',
					MY_APP_PROTOCOL_HEADER: 'X-Forwarded-Proto',
					MY_APP_HOST_HEADER: 'X-Forwarded-Host',
					MY_APP_PORT_HEADER: 'X-Forwarded-Port',
					MY_APP_BODY_SIZE_LIMIT: '1M',
					MY_APP_CONNECTION_IDLE_TIMEOUT: '120',
					MY_APP_SHUTDOWN_TIMEOUT: '5'
				},
				'MY_APP_',
				noop
			)
		).toEqual({
			host: '127.0.0.1',
			port: 8080,
			xff_depth: 3,
			address_header: 'x-forwarded-for',
			protocol_header: 'x-forwarded-proto',
			host_header: 'x-forwarded-host',
			port_header: 'x-forwarded-port',
			body_size_limit: 1024 * 1024,
			connection_idle_timeout: 120,
			shutdown_timeout: 5
		});
	});

	test('validates before parsing, so a colliding prefix is reported first', () => {
		expect(() => read_config({ MY_APP_PORT: 'abc', MY_APP_OTHER: '1' }, 'MY_APP_', noop)).toThrow(
			/change envPrefix/
		);
	});

	test.each(['abc', '-1', '70000', '1.5'])('rejects PORT=%s', (value) => {
		expect(() => read_config({ PORT: value }, '', noop)).toThrow(
			/PORT must be an integer between 0 and 65535/
		);
	});

	test.each(['abc', '0', '-1', '1.5'])('rejects XFF_DEPTH=%s', (value) => {
		expect(() => read_config({ XFF_DEPTH: value }, '', noop)).toThrow(
			/XFF_DEPTH must be a positive integer/
		);
	});

	test('rejects a CONNECTION_IDLE_TIMEOUT above Bun’s 255s ceiling instead of clamping it', () => {
		expect(() => read_config({ CONNECTION_IDLE_TIMEOUT: '256' }, '', noop)).toThrow(
			/CONNECTION_IDLE_TIMEOUT must be at most 255 seconds/
		);
		expect(read_config({ CONNECTION_IDLE_TIMEOUT: '255' }, '', noop).connection_idle_timeout).toBe(
			255
		);
	});

	test('error messages carry the prefix', () => {
		expect(() => read_config({ MY_APP_SHUTDOWN_TIMEOUT: 'soon' }, 'MY_APP_', noop)).toThrow(
			/MY_APP_SHUTDOWN_TIMEOUT must be a non-negative integer/
		);
	});
});

describe('parse_timeout', () => {
	test.each([
		['0', 0],
		['30', 30],
		['255', 255]
	] as const)('parses %s', (input, expected) => {
		expect(parse_timeout(input, 'SHUTDOWN_TIMEOUT')).toBe(expected);
	});

	test.each(['', 'abc', '-1', '1.5', '1e3', ' 5', '5s'])('rejects %s', (input) => {
		expect(() => parse_timeout(input, 'SHUTDOWN_TIMEOUT')).toThrow(
			/SHUTDOWN_TIMEOUT must be a non-negative integer number of seconds/
		);
	});

	test('enforces an optional maximum', () => {
		expect(() => parse_timeout('256', 'CONNECTION_IDLE_TIMEOUT', 255)).toThrow(
			/must be at most 255 seconds \(got '256'\)/
		);
	});
});

describe('mime_type', () => {
	const mime_types = {
		'.css': 'text/css',
		'.html': 'text/html',
		'.jxl': 'image/jxl',
		'.ico': 'image/x-icon'
	};

	test('resolves the manifest type for a known extension', () => {
		expect(mime_type('/_app/immutable/assets/app.abc.css', mime_types)).toBe('text/css');
	});

	test('prefers manifest types over Bun’s extension mapping', () => {
		expect(mime_type('/custom.jxl', mime_types)).toBe('image/jxl');
		expect(mime_type('/favicon.ico', mime_types)).toBe('image/x-icon');
	});

	test('appends charset to text/html', () => {
		expect(mime_type('/page.html', mime_types)).toBe('text/html;charset=utf-8');
	});

	test('returns undefined for unknown or extension-less paths', () => {
		expect(mime_type('/about', mime_types)).toBeUndefined();
		expect(mime_type('/data.bin', mime_types)).toBeUndefined();
		// a dot in a directory name is not an extension
		expect(mime_type('/v1.2/readme', mime_types)).toBeUndefined();
		expect(mime_type('/a.css', undefined)).toBeUndefined();
	});
});

describe('relative_pathname', () => {
	test('adds a trailing slash', () => {
		expect(relative_pathname('/about', '/about/')).toBe('about/');
		expect(relative_pathname('/a/b/c', '/a/b/c/')).toBe('c/');
	});

	test('removes a trailing slash', () => {
		expect(relative_pathname('/about/', '/about')).toBe('../about');
		expect(relative_pathname('/a/b/c/', '/a/b/c')).toBe('../c');
	});

	test('result resolves to the target regardless of mount prefix', () => {
		for (const prefix of ['', '/app', '/deep/mount']) {
			const resolve = (from: string, to: string) =>
				new URL(relative_pathname(from, to), `http://x${prefix}${from}`).pathname;

			expect(resolve('/about/', '/about')).toBe(`${prefix}/about`);
			expect(resolve('/about', '/about/')).toBe(`${prefix}/about/`);
		}
	});
});

describe('parse_as_bytes', () => {
	test.each([
		['200', 200],
		['512K', 512 * 1024],
		['200M', 200 * 1024 * 1024],
		['1G', 1024 * 1024 * 1024],
		['0', 0],
		['1k', 1024],
		['1g', 1024 * 1024 * 1024]
	] as const)('parses %s as %d', (input, expected) => {
		expect(parse_as_bytes(input, 'BODY_SIZE_LIMIT')).toBe(expected);
	});

	test.each(['abc', '-1', '-1K', 'Kabc', '1.2.3'] as const)(
		'throws on invalid input: %s',
		(input) => {
			expect(() => parse_as_bytes(input, 'BODY_SIZE_LIMIT')).toThrow(/BODY_SIZE_LIMIT must be/);
		}
	);

	test('embeds env_name in error message', () => {
		expect(() => parse_as_bytes('abc', 'MY_APP_BODY_SIZE_LIMIT')).toThrow(/MY_APP_BODY_SIZE_LIMIT/);
	});
});

describe('resolve_origin', () => {
	const base_cfg = {
		protocol_header: '',
		host_header: '',
		port_header: ''
	};

	function make_request(headers: Record<string, string> = {}) {
		return new Request('http://localhost:3000/path', { headers });
	}

	test('short-circuits to the configured `kit.paths.origin` when set', () => {
		const req = make_request({
			'x-forwarded-proto': 'https',
			'x-forwarded-host': 'evil.com'
		});
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				...base_cfg,
				origin: 'https://example.com',
				protocol_header: 'x-forwarded-proto',
				host_header: 'x-forwarded-host'
			})
		).toBe('https://example.com');
	});

	test('returns undefined when no headers are configured', () => {
		const req = make_request();
		const url = new URL(req.url);
		expect(resolve_origin(req, url, base_cfg)).toBeUndefined();
	});

	test('builds from protocol_header + host_header', () => {
		const req = make_request({
			'x-forwarded-proto': 'https',
			'x-forwarded-host': 'example.com'
		});
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				...base_cfg,
				protocol_header: 'x-forwarded-proto',
				host_header: 'x-forwarded-host'
			})
		).toBe('https://example.com');
	});

	test('appends port when port_header set', () => {
		const req = make_request({
			'x-forwarded-proto': 'https',
			'x-forwarded-host': 'example.com',
			'x-forwarded-port': '8443'
		});
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				protocol_header: 'x-forwarded-proto',
				host_header: 'x-forwarded-host',
				port_header: 'x-forwarded-port'
			})
		).toBe('https://example.com:8443');
	});

	test('falls back to url.hostname when host_header absent', () => {
		const req = make_request({ 'x-forwarded-proto': 'https' });
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				...base_cfg,
				protocol_header: 'x-forwarded-proto',
				host_header: 'x-forwarded-host'
			})
		).toBe('https://localhost');
	});

	test('throws when protocol_header value contains a colon (host-injection guard)', () => {
		const req = make_request({ 'x-forwarded-proto': 'https://evil.com' });
		const url = new URL(req.url);
		expect(() =>
			resolve_origin(req, url, {
				...base_cfg,
				protocol_header: 'x-forwarded-proto'
			})
		).toThrow(/invalid because it includes/);
	});

	test('throws when port_header value is not a number', () => {
		const req = make_request({ 'x-forwarded-port': 'abc' });
		const url = new URL(req.url);
		expect(() =>
			resolve_origin(req, url, {
				...base_cfg,
				port_header: 'x-forwarded-port'
			})
		).toThrow(/invalid port/);
	});
});

describe('get_client_address', () => {
	const srv = {
		requestIP: () => ({ address: '127.0.0.1', port: 1234, family: 'IPv4' })
	} as unknown as import('bun').Server<unknown>;

	test('falls back to socket IP when no address_header', () => {
		const req = new Request('http://localhost/');
		expect(get_client_address(req, srv, '', 1, '')).toBe('127.0.0.1');
	});

	test('returns empty string when srv.requestIP returns null', () => {
		const null_srv = {
			requestIP: () => null
		} as unknown as import('bun').Server<unknown>;
		const req = new Request('http://localhost/');
		expect(get_client_address(req, null_srv, '', 1, '')).toBe('');
	});

	test('throws when configured header is missing', () => {
		const req = new Request('http://localhost/');
		expect(() => get_client_address(req, srv, 'x-client-ip', 1, '')).toThrow(
			/ADDRESS_HEADER=x-client-ip but is absent/
		);
	});

	test('returns non-XFF header value verbatim', () => {
		const req = new Request('http://localhost/', {
			headers: { 'x-client-ip': '203.0.113.5' }
		});
		expect(get_client_address(req, srv, 'x-client-ip', 1, '')).toBe('203.0.113.5');
	});

	test('XFF: picks rightmost when depth=1', () => {
		const req = new Request('http://localhost/', {
			headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }
		});
		expect(get_client_address(req, srv, 'x-forwarded-for', 1, '')).toBe('3.3.3.3');
	});

	test('XFF: picks Nth-from-right with depth=N', () => {
		const req = new Request('http://localhost/', {
			headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }
		});
		expect(get_client_address(req, srv, 'x-forwarded-for', 2, '')).toBe('2.2.2.2');
		expect(get_client_address(req, srv, 'x-forwarded-for', 3, '')).toBe('1.1.1.1');
	});

	test('XFF: trims whitespace from addresses', () => {
		const req = new Request('http://localhost/', {
			headers: { 'x-forwarded-for': '  1.1.1.1  ,  2.2.2.2  ' }
		});
		expect(get_client_address(req, srv, 'x-forwarded-for', 1, '')).toBe('2.2.2.2');
	});

	test('XFF: throws when depth exceeds address count', () => {
		const req = new Request('http://localhost/', {
			headers: { 'x-forwarded-for': '1.1.1.1' }
		});
		expect(() => get_client_address(req, srv, 'x-forwarded-for', 5, 'MY_')).toThrow(
			/MY_XFF_DEPTH is 5, but only found 1 addresses/
		);
	});
});

describe('make_asset_handler', () => {
	const FILE_SIZE = 1000;

	beforeEach(() => {
		vi.stubGlobal('Bun', {
			file: (_path: string) => ({
				type: 'image/png',
				size: FILE_SIZE,
				slice: (start: number, end: number) =>
					new Blob([new Uint8Array(end - start)], { type: 'image/png' })
			})
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('GET returns 200 with body and headers', async () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(new Request('http://localhost/favicon.png'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.body).not.toBeNull();
	});

	test('HEAD returns headers but null body', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(new Request('http://localhost/favicon.png', { method: 'HEAD' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		expect(res.body).toBeNull();
	});

	test('OPTIONS returns 204 with allow header', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(new Request('http://localhost/favicon.png', { method: 'OPTIONS' }));
		expect(res.status).toBe(204);
		expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
	});

	test.each(['POST', 'PUT', 'DELETE', 'PATCH'] as const)('%s returns 405', (method) => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(new Request('http://localhost/favicon.png', { method }));
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
	});

	test('valid Range returns 206 with content-range', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=100-199' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 100-199/${FILE_SIZE}`);
		expect(res.headers.get('content-length')).toBe('100');
	});

	test('open-ended Range bytes=100- uses size-1 as end', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=100-' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 100-${FILE_SIZE - 1}/${FILE_SIZE}`);
	});

	test('unsatisfiable Range (end >= size) returns 416', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: `bytes=0-${FILE_SIZE}` }
			})
		);
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${FILE_SIZE}`);
	});

	test('Range with start > end returns 416', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=500-100' }
			})
		);
		expect(res.status).toBe(416);
	});

	test('malformed Range header falls through to 200', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=abc-' }
			})
		);
		expect(res.status).toBe(416);
	});

	test('explicit `type` overrides Bun’s file type', () => {
		const handler = make_asset_handler('/bunfs/custom.jxl', {
			type: 'image/jxl'
		});
		const res = handler(new Request('http://localhost/custom.jxl'));
		expect(res.headers.get('content-type')).toBe('image/jxl');
	});

	test('`cache_control` is set on 200 and 206 responses', () => {
		const handler = make_asset_handler('/bunfs/app.js', {
			cache_control: 'public,max-age=31536000,immutable'
		});
		expect(handler(new Request('http://localhost/app.js')).headers.get('cache-control')).toBe(
			'public,max-age=31536000,immutable'
		);
		const ranged = handler(
			new Request('http://localhost/app.js', {
				headers: { range: 'bytes=0-9' }
			})
		);
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get('cache-control')).toBe('public,max-age=31536000,immutable');
	});

	test('no cache-control without the option', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		expect(
			handler(new Request('http://localhost/favicon.png')).headers.get('cache-control')
		).toBeNull();
	});

	test('HEAD with valid Range returns 206 with null body', () => {
		const handler = make_asset_handler('/bunfs/favicon.png');
		const res = handler(
			new Request('http://localhost/favicon.png', {
				method: 'HEAD',
				headers: { range: 'bytes=0-99' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.body).toBeNull();
	});
});

/**
 * `start()` is where the SvelteKit 3 behaviours are wired together: the route table
 * (manifest MIME types + immutable caching), the relative prerender redirect, the
 * baked-in `kit.paths.origin`, and the SSE opt-outs. The integration specs cover it
 * end to end; these tests pin the same behaviour down cheaply by stubbing `Bun`, so a
 * regression names the exact rule it broke.
 */
describe('start', () => {
	type Handler = (request: Request) => Response;

	interface ServeOptions {
		hostname: string;
		port: number;
		idleTimeout: number;
		maxRequestBodySize: number;
		routes: Record<string, Handler>;
		fetch: (request: Request, srv: unknown) => Promise<Response>;
	}

	interface Runtime {
		serve: ServeOptions;
		srv: unknown;
		/** `srv.timeout(request, seconds)` calls made by the fetch handler. */
		timeouts: { request: Request; seconds: number }[];
		/** Requests as SvelteKit saw them (after any origin rewrite). */
		responded: Request[];
		dispose: () => void;
	}

	async function start_runtime({
		manifest = {},
		client_assets = {},
		prerendered_assets = {},
		prerendered = [],
		respond = async () => new Response('ssr'),
		origin
	}: {
		manifest?: { appPath?: string; mimeTypes?: Record<string, string> };
		client_assets?: Record<string, string>;
		prerendered_assets?: Record<string, string>;
		prerendered?: string[];
		respond?: (request: Request) => Promise<Response>;
		origin?: string;
	} = {}): Promise<Runtime> {
		const timeouts: Runtime['timeouts'] = [];
		const responded: Request[] = [];

		const srv = {
			stop: () => {},
			timeout: (request: Request, seconds: number) => timeouts.push({ request, seconds }),
			requestIP: () => ({ address: '1.2.3.4', family: 'IPv4', port: 1234 })
		};

		let resolve_serve: (options: ServeOptions) => void = () => {};
		const serve_called = new Promise<ServeOptions>((resolve) => (resolve_serve = resolve));

		vi.stubGlobal('Bun', {
			// `size` is derived from the path so that a response identifies which
			// `$bunfs` file its handler was built from
			file: (path: string) => ({
				type: 'application/octet-stream',
				size: path.length,
				slice: (start_byte: number, end: number) => new Blob([new Uint8Array(end - start_byte)]),
				stream: () => new Blob([new Uint8Array(path.length)]).stream()
			}),
			serve: (options: ServeOptions) => {
				resolve_serve(options);
				return srv;
			}
		});

		class FakeServer {
			constructor(_manifest: unknown) {}
			async init(_options: unknown) {}
			async respond(request: Request, _options: unknown) {
				responded.push(request);
				return respond(request);
			}
		}

		// `start()` only settles on SIGTERM/SIGINT, so it is deliberately not awaited;
		// the handlers it installs are removed again by `dispose()`.
		const signals = ['SIGTERM', 'SIGINT'] as const;
		const before = new Map(signals.map((s) => [s, new Set(process.listeners(s))]));

		const started = start({
			Server: FakeServer as never,
			manifest: { appPath: '_app', mimeTypes: {}, ...manifest } as never,
			prerendered: new Set(prerendered),
			client_assets,
			prerendered_assets,
			server_assets: {},
			origin
		});

		const serve = await Promise.race([
			serve_called,
			started.then((): ServeOptions => {
				throw new Error('start() settled before Bun.serve was called');
			})
		]);
		started.catch(() => {});

		return {
			serve,
			srv,
			timeouts,
			responded,
			dispose: () => {
				for (const signal of signals) {
					for (const listener of process.listeners(signal)) {
						if (!before.get(signal)?.has(listener)) process.removeListener(signal, listener);
					}
				}
			}
		};
	}

	let runtime: Runtime | null = null;

	afterEach(() => {
		runtime?.dispose();
		runtime = null;
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	describe('route table', () => {
		test('immutable client assets are cached forever, everything else is not', async () => {
			runtime = await start_runtime({
				client_assets: {
					'/_app/immutable/chunks/app.abc.js': '/bunfs/app.abc.js',
					'/_app/version.json': '/bunfs/version.json',
					'/favicon.png': '/bunfs/favicon.png'
				},
				prerendered_assets: { '/about': '/bunfs/about.html' }
			});

			const cache_control = (path: string) =>
				runtime!.serve.routes[path](new Request(`http://localhost${path}`)).headers.get(
					'cache-control'
				);

			expect(cache_control('/_app/immutable/chunks/app.abc.js')).toBe(
				'public,max-age=31536000,immutable'
			);
			expect(cache_control('/_app/version.json')).toBeNull();
			expect(cache_control('/favicon.png')).toBeNull();
			// prerendered pages are regenerated on every deploy, so they must not be immutable
			expect(cache_control('/about')).toBeNull();
		});

		test('the immutable prefix follows manifest.appPath, so it works under kit.paths.base', async () => {
			// with `kit.paths.base = '/app'` SvelteKit reports `appPath: 'app/_app'` and the
			// adapter keys client assets under the same prefix
			runtime = await start_runtime({
				manifest: { appPath: 'app/_app' },
				client_assets: {
					'/app/_app/immutable/chunks/app.abc.js': '/bunfs/app.abc.js',
					'/app/_app/version.json': '/bunfs/version.json'
				}
			});

			const cache_control = (path: string) =>
				runtime!.serve.routes[path](new Request(`http://localhost${path}`)).headers.get(
					'cache-control'
				);

			expect(cache_control('/app/_app/immutable/chunks/app.abc.js')).toBe(
				'public,max-age=31536000,immutable'
			);
			expect(cache_control('/app/_app/version.json')).toBeNull();
		});

		test('content types come from the manifest for client and prerendered assets alike', async () => {
			runtime = await start_runtime({
				manifest: { mimeTypes: { '.jxl': 'image/jxl', '.html': 'text/html' } },
				client_assets: { '/custom.jxl': '/bunfs/custom.jxl', '/data.bin': '/bunfs/data.bin' },
				prerendered_assets: { '/about.html': '/bunfs/about.html' }
			});

			const type = (path: string) =>
				runtime!.serve.routes[path](new Request(`http://localhost${path}`)).headers.get(
					'content-type'
				);

			expect(type('/custom.jxl')).toBe('image/jxl');
			expect(type('/about.html')).toBe('text/html;charset=utf-8');
			// no manifest entry: Bun's own type for the file is the fallback
			expect(type('/data.bin')).toBe('application/octet-stream');
		});

		test('prerendered assets win over client assets on key overlap', async () => {
			runtime = await start_runtime({
				client_assets: { '/overlap': '/bunfs/client' },
				prerendered_assets: { '/overlap': '/bunfs/prerendered-file' }
			});

			expect(Object.keys(runtime.serve.routes)).toEqual(['/overlap']);
			const res = runtime.serve.routes['/overlap'](new Request('http://localhost/overlap'));
			expect(res.headers.get('content-length')).toBe(String('/bunfs/prerendered-file'.length));
		});
	});

	describe('fetch handler', () => {
		test('redirects a prerendered page’s trailing-slash variant with a relative location', async () => {
			runtime = await start_runtime({ prerendered: ['/about'] });

			const res = await runtime.serve.fetch(
				new Request('http://localhost/about/?q=1'),
				runtime.srv
			);
			expect(res.status).toBe(308);
			expect(res.headers.get('location')).toBe('../about?q=1');
			// the redirect short-circuits: SvelteKit is never asked
			expect(runtime.responded).toHaveLength(0);
		});

		test('a baked-in origin replaces the request origin SvelteKit sees', async () => {
			runtime = await start_runtime({ origin: 'https://example.com' });

			await runtime.serve.fetch(new Request('http://127.0.0.1:3000/deep?q=1'), runtime.srv);
			expect(runtime.responded[0].url).toBe('https://example.com/deep?q=1');
		});

		test('without an origin the request is passed through untouched', async () => {
			runtime = await start_runtime();

			const request = new Request('http://127.0.0.1:3000/deep');
			await runtime.serve.fetch(request, runtime.srv);
			expect(runtime.responded[0]).toBe(request);
		});

		test('SSE responses opt out of proxy buffering', async () => {
			runtime = await start_runtime({
				respond: async () =>
					new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } })
			});

			const res = await runtime.serve.fetch(new Request('http://localhost/sse'), runtime.srv);
			expect(res.headers.get('x-accel-buffering')).toBe('no');
		});

		test('SSE responses opt out of a configured connection idle timeout', async () => {
			vi.stubEnv('CONNECTION_IDLE_TIMEOUT', '30');
			runtime = await start_runtime({
				respond: async () =>
					new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } })
			});
			expect(runtime.serve.idleTimeout).toBe(30);

			const request = new Request('http://localhost/sse');
			await runtime.serve.fetch(request, runtime.srv);
			expect(runtime.timeouts).toEqual([{ request, seconds: 0 }]);
		});

		test('no per-request timeout override is needed with the default (no) timeout', async () => {
			runtime = await start_runtime({
				respond: async () =>
					new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } })
			});
			expect(runtime.serve.idleTimeout).toBe(0);

			await runtime.serve.fetch(new Request('http://localhost/sse'), runtime.srv);
			expect(runtime.timeouts).toEqual([]);
		});

		test('non-streaming responses are left alone', async () => {
			runtime = await start_runtime({
				respond: async () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })
			});

			const res = await runtime.serve.fetch(new Request('http://localhost/'), runtime.srv);
			expect(res.headers.get('x-accel-buffering')).toBeNull();
			expect(runtime.timeouts).toEqual([]);
		});

		test('an error from SvelteKit becomes a 500 instead of crashing the server', async () => {
			runtime = await start_runtime({
				respond: async () => {
					throw new Error('boom');
				}
			});

			const res = await runtime.serve.fetch(new Request('http://localhost/'), runtime.srv);
			expect(res.status).toBe(500);
		});
	});

	test('the configuration read from the environment reaches Bun.serve', async () => {
		vi.stubEnv('HOST', '127.0.0.1');
		vi.stubEnv('PORT', '4321');
		vi.stubEnv('BODY_SIZE_LIMIT', '1M');
		vi.stubEnv('CONNECTION_IDLE_TIMEOUT', '5');
		runtime = await start_runtime();

		expect(runtime.serve.hostname).toBe('127.0.0.1');
		expect(runtime.serve.port).toBe(4321);
		expect(runtime.serve.maxRequestBodySize).toBe(1024 * 1024);
		expect(runtime.serve.idleTimeout).toBe(5);
	});

	test('an unusable configuration fails before the app is initialised', async () => {
		vi.stubEnv('PORT', 'nope');
		vi.stubGlobal('Bun', {
			serve: () => {
				throw new Error('Bun.serve must not be reached');
			}
		});

		let initialised = false;
		class FakeServer {
			constructor(_manifest: unknown) {
				initialised = true;
			}
			async init() {}
			async respond() {
				return new Response('');
			}
		}

		await expect(
			start({
				Server: FakeServer as never,
				manifest: { appPath: '_app', mimeTypes: {} } as never,
				prerendered: new Set(),
				client_assets: {},
				prerendered_assets: {},
				server_assets: {}
			})
		).rejects.toThrow(/PORT must be an integer/);
		expect(initialised).toBe(false);
	});
});
