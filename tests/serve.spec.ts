import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	create_file_map,
	decode_pathname,
	etag_matches,
	get_client_address,
	make_asset_handler,
	mime_type,
	negotiate,
	parse_as_bytes,
	parse_timeout,
	read_config,
	relative_pathname,
	remove_stale_socket,
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
			validate_env({ IDLE_TIMEOUT: '5', KEEP_ALIVE_TIMEOUT: '5' }, '', (m) => warnings.push(m))
		).not.toThrow();
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatch(/IDLE_TIMEOUT is not supported.*It is being ignored/s);
		expect(warnings[1]).toContain('KEEP_ALIVE_TIMEOUT is not supported');
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
			socket_path: '',
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
					MY_APP_SOCKET_PATH: '/tmp/app.sock',
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
			socket_path: '/tmp/app.sock',
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

	test('SOCKET_PATH defaults to empty (no socket configured)', () => {
		expect(read_config({}, '', noop).socket_path).toBe('');
	});

	test('SOCKET_PATH is read through the prefix, alongside a default PORT', () => {
		expect(read_config({ MY_APP_SOCKET_PATH: '/run/app.sock' }, 'MY_APP_', noop)).toMatchObject({
			socket_path: '/run/app.sock',
			port: 3000
		});
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

describe('remove_stale_socket', () => {
	let dir = '';

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'adapter-bun-socket-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('removes an empty (stale) file at the path', () => {
		const path = join(dir, 'app.sock');
		writeFileSync(path, '');
		remove_stale_socket(path);
		expect(existsSync(path)).toBe(false);
	});

	test('leaves a non-empty file alone', () => {
		const path = join(dir, 'app.sock');
		writeFileSync(path, 'not actually a socket');
		remove_stale_socket(path);
		expect(existsSync(path)).toBe(true);
	});

	test('does nothing, and does not throw, when there is no file at the path', () => {
		const path = join(dir, 'missing.sock');
		expect(() => remove_stale_socket(path)).not.toThrow();
		expect(existsSync(path)).toBe(false);
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

	test('short-circuits to the configured `paths.origin` when set', () => {
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

	test('defaults the protocol to https when no PROTOCOL_HEADER is configured', () => {
		const req = make_request();
		const url = new URL(req.url);
		expect(resolve_origin(req, url, base_cfg)).toBe('https://localhost:3000');
	});

	test('defaults the protocol to https when PROTOCOL_HEADER is configured but absent from the request', () => {
		const req = make_request();
		const url = new URL(req.url);
		expect(resolve_origin(req, url, { ...base_cfg, protocol_header: 'x-forwarded-proto' })).toBe(
			'https://localhost:3000'
		);
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

	test('falls back to url.host when host_header absent', () => {
		const req = make_request({ 'x-forwarded-proto': 'https' });
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				...base_cfg,
				protocol_header: 'x-forwarded-proto',
				host_header: 'x-forwarded-host'
			})
		).toBe('https://localhost:3000');
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

	test('decodeURIComponent-decodes the protocol header value', () => {
		// %68 -> 'h'
		const req = make_request({ 'x-forwarded-proto': '%68ttps' });
		const url = new URL(req.url);
		expect(resolve_origin(req, url, { ...base_cfg, protocol_header: 'x-forwarded-proto' })).toBe(
			'https://localhost:3000'
		);
	});

	test('throws on a comma-joined (multi-valued) protocol_header', () => {
		// Bun's Headers.get() joins repeated headers with ", " — a single-value proxy
		// header receiving more than one value is therefore indistinguishable from a
		// literal comma in the value, and both are rejected the same way upstream
		// rejects an array of values for one of these headers.
		const req = make_request({ 'x-forwarded-proto': 'https, http' });
		const url = new URL(req.url);
		expect(() =>
			resolve_origin(req, url, { ...base_cfg, protocol_header: 'x-forwarded-proto' })
		).toThrow(/Multiple values provided for x-forwarded-proto/);
	});

	test('throws on a comma-joined (multi-valued) host_header', () => {
		const req = make_request({ 'x-forwarded-host': 'a.com, b.com' });
		const url = new URL(req.url);
		expect(() =>
			resolve_origin(req, url, { ...base_cfg, host_header: 'x-forwarded-host' })
		).toThrow(/Multiple values provided for x-forwarded-host/);
	});

	test('throws on a comma-joined (multi-valued) port_header', () => {
		const req = make_request({ 'x-forwarded-port': '443, 8443' });
		const url = new URL(req.url);
		expect(() =>
			resolve_origin(req, url, { ...base_cfg, port_header: 'x-forwarded-port' })
		).toThrow(/Multiple values provided for x-forwarded-port/);
	});

	test('throws when no host can be determined at all', () => {
		// `url.host` is never empty for a real request through Bun.serve (the URL always
		// has an authority), but a HOST_HEADER configured to a header absent from the
		// request, combined with a stubbed empty `url.host`, is the shape upstream's
		// "Could not determine host" guard exists for — kept here for parity even though
		// this adapter can't otherwise reach it.
		const req = make_request();
		const url = { host: '', hostname: '', protocol: 'http:' } as unknown as URL;
		expect(() =>
			resolve_origin(req, url, { ...base_cfg, host_header: 'x-forwarded-host' })
		).toThrow(/Could not determine host/);
	});
});

describe('decode_pathname', () => {
	test('decodes a plain percent-encoded pathname', () => {
		expect(decode_pathname('/caf%C3%A9')).toBe('/café');
	});

	test('leaves a pathname without `%` untouched', () => {
		expect(decode_pathname('/about')).toBe('/about');
	});

	test('keeps %2F (reserved) encoded', () => {
		expect(decode_pathname('/a%2Fb')).toBe('/a%2Fb');
	});

	test('keeps a literal %25 encoded while still decoding neighbouring escapes', () => {
		// splitting on the literal '%25' before decoding is what keeps it from being
		// turned into a bare '%' — plain decodeURIComponent would decode it
		expect(decode_pathname('/100%25off%20now')).toBe('/100%25off now');
	});

	test('a malformed % escape is left undecoded rather than throwing', () => {
		expect(decode_pathname('/bad%')).toBe('/bad%');
		expect(() => decode_pathname('/bad%')).not.toThrow();
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
	const ETAG = 'abc123';
	const QUOTED_ETAG = `"${ETAG}"`;

	beforeEach(() => {
		vi.stubGlobal('Bun', {
			file: (_path: string) => ({
				type: 'image/png',
				slice: (start: number, end: number) =>
					new Blob([new Uint8Array(end - start)], { type: 'image/png' })
			})
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Build a full `Asset` for `make_asset_handler`, overriding only what a test cares about. */
	function asset(overrides: Partial<Parameters<typeof make_asset_handler>[0]> = {}) {
		return { file: '/bunfs/favicon.png', size: FILE_SIZE, etag: ETAG, ...overrides };
	}

	test('GET returns 200 with body, etag, and headers', async () => {
		const handler = make_asset_handler(asset());
		const res = handler(new Request('http://localhost/favicon.png'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('etag')).toBe(QUOTED_ETAG);
		expect(res.body).not.toBeNull();
	});

	test('HEAD returns headers but null body', () => {
		const handler = make_asset_handler(asset());
		const res = handler(new Request('http://localhost/favicon.png', { method: 'HEAD' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		expect(res.body).toBeNull();
	});

	test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const)('%s returns 405', (method) => {
		const handler = make_asset_handler(asset());
		const res = handler(new Request('http://localhost/favicon.png', { method }));
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('GET, HEAD');
	});

	test('valid Range returns 206 with content-range', () => {
		const handler = make_asset_handler(asset());
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
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=100-' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 100-${FILE_SIZE - 1}/${FILE_SIZE}`);
	});

	test('suffix Range bytes=-N returns the last N bytes', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=-100' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(
			`bytes ${FILE_SIZE - 100}-${FILE_SIZE - 1}/${FILE_SIZE}`
		);
		expect(res.headers.get('content-length')).toBe('100');
	});

	test('a suffix Range larger than the file clamps the start to 0', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: `bytes=-${FILE_SIZE * 2}` }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
	});

	test('Range with neither bound (bytes=-) is ignored, falling through to a full 200', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=-' }
			})
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
	});

	test('an end beyond size - 1 is clamped rather than rejected with 416', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: `bytes=0-${FILE_SIZE}` }
			})
		);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
	});

	test('Range with start >= size returns 416', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: `bytes=${FILE_SIZE}-${FILE_SIZE + 10}` }
			})
		);
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${FILE_SIZE}`);
	});

	test('Range with start > end returns 416', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=500-100' }
			})
		);
		expect(res.status).toBe(416);
	});

	test('malformed Range header falls through to 200', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				headers: { range: 'bytes=abc-' }
			})
		);
		expect(res.status).toBe(200);
	});

	test('explicit `type` overrides Bun’s file type', () => {
		const handler = make_asset_handler(asset({ file: '/bunfs/custom.jxl', type: 'image/jxl' }));
		const res = handler(new Request('http://localhost/custom.jxl'));
		expect(res.headers.get('content-type')).toBe('image/jxl');
	});

	test('`cache_control` is set on 200 and 206 responses', () => {
		const handler = make_asset_handler(
			asset({ file: '/bunfs/app.js', cache_control: 'public,max-age=31536000,immutable' })
		);
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
		const handler = make_asset_handler(asset());
		expect(
			handler(new Request('http://localhost/favicon.png')).headers.get('cache-control')
		).toBeNull();
	});

	test('HEAD with valid Range returns 206 with null body', () => {
		const handler = make_asset_handler(asset());
		const res = handler(
			new Request('http://localhost/favicon.png', {
				method: 'HEAD',
				headers: { range: 'bytes=0-99' }
			})
		);
		expect(res.status).toBe(206);
		expect(res.body).toBeNull();
	});

	describe('conditional requests (If-None-Match)', () => {
		test('an exact matching etag returns 304 with etag + cache-control only', () => {
			const handler = make_asset_handler(
				asset({ cache_control: 'public,max-age=31536000,immutable' })
			);
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'if-none-match': QUOTED_ETAG }
				})
			);
			expect(res.status).toBe(304);
			expect(res.headers.get('etag')).toBe(QUOTED_ETAG);
			expect(res.headers.get('cache-control')).toBe('public,max-age=31536000,immutable');
			expect(res.headers.get('content-length')).toBeNull();
			expect(res.headers.get('content-type')).toBeNull();
			expect(res.body).toBeNull();
		});

		test('a weak (W/-prefixed) matching etag also returns 304', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'if-none-match': `W/${QUOTED_ETAG}` }
				})
			);
			expect(res.status).toBe(304);
		});

		test('a wildcard `*` returns 304', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', { headers: { 'if-none-match': '*' } })
			);
			expect(res.status).toBe(304);
		});

		test('one match among a comma-separated list returns 304', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'if-none-match': `"other", ${QUOTED_ETAG}` }
				})
			);
			expect(res.status).toBe(304);
		});

		test('a non-matching etag returns the full 200', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', { headers: { 'if-none-match': '"other"' } })
			);
			expect(res.status).toBe(200);
		});

		test('HEAD also honours If-None-Match', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					method: 'HEAD',
					headers: { 'if-none-match': QUOTED_ETAG }
				})
			);
			expect(res.status).toBe(304);
			expect(res.body).toBeNull();
		});
	});

	describe('If-Range', () => {
		test('a matching If-Range honours the Range request', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { range: 'bytes=0-9', 'if-range': QUOTED_ETAG }
				})
			);
			expect(res.status).toBe(206);
		});

		test('a stale If-Range ignores the Range and returns the full current representation', () => {
			const handler = make_asset_handler(asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { range: 'bytes=0-9', 'if-range': '"stale"' }
				})
			);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		});
	});

	describe('precompressed variants', () => {
		const BR_SIZE = 400;
		const GZ_SIZE = 600;

		function variant_asset(overrides: Partial<Parameters<typeof make_asset_handler>[0]> = {}) {
			return asset({
				br: { file: '/bunfs/favicon.png.br', size: BR_SIZE },
				gz: { file: '/bunfs/favicon.png.gz', size: GZ_SIZE },
				...overrides
			});
		}

		test('no Accept-Encoding header serves the identity representation', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(new Request('http://localhost/favicon.png'));
			expect(res.status).toBe(200);
			expect(res.headers.get('content-encoding')).toBeNull();
			expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
			expect(res.headers.get('etag')).toBe(QUOTED_ETAG);
		});

		test('br is preferred over gzip when both are acceptable', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'gzip, br' }
				})
			);
			expect(res.headers.get('content-encoding')).toBe('br');
			expect(res.headers.get('content-length')).toBe(String(BR_SIZE));
			expect(res.headers.get('etag')).toBe(`"${ETAG}.br"`);
		});

		test('gzip is preferred when its q-value is strictly higher than br', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'br;q=0.5, gzip;q=0.8' }
				})
			);
			expect(res.headers.get('content-encoding')).toBe('gzip');
			expect(res.headers.get('content-length')).toBe(String(GZ_SIZE));
			expect(res.headers.get('etag')).toBe(`"${ETAG}.gz"`);
		});

		test('a wildcard `*` supplies the fallback weight for an unlisted coding', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': '*' }
				})
			);
			expect(res.headers.get('content-encoding')).toBe('br');
		});

		test('q=0 refuses a coding even when it would otherwise be preferred', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'br;q=0, gzip' }
				})
			);
			expect(res.headers.get('content-encoding')).toBe('gzip');
		});

		test('Vary: Accept-Encoding is present whenever variants exist, negotiated or not', () => {
			const handler = make_asset_handler(variant_asset());
			expect(handler(new Request('http://localhost/favicon.png')).headers.get('vary')).toBe(
				'Accept-Encoding'
			);
			expect(
				handler(
					new Request('http://localhost/favicon.png', { headers: { 'accept-encoding': 'br' } })
				).headers.get('vary')
			).toBe('Accept-Encoding');
		});

		test('no Vary header when the asset has no variants', () => {
			const handler = make_asset_handler(asset());
			expect(handler(new Request('http://localhost/favicon.png')).headers.get('vary')).toBeNull();
		});

		test('If-None-Match against the negotiated variant etag returns 304', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'br', 'if-none-match': `"${ETAG}.br"` }
				})
			);
			expect(res.status).toBe(304);
			expect(res.headers.get('vary')).toBe('Accept-Encoding');
			expect(res.headers.get('etag')).toBe(`"${ETAG}.br"`);
		});

		test('If-None-Match against the base etag does not match a negotiated variant', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'br', 'if-none-match': QUOTED_ETAG }
				})
			);
			expect(res.status).toBe(200);
		});

		test('Range applies to the negotiated variant, sized off the variant', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'gzip', range: 'bytes=0-99' }
				})
			);
			expect(res.status).toBe(206);
			expect(res.headers.get('content-range')).toBe(`bytes 0-99/${GZ_SIZE}`);
			expect(res.headers.get('content-encoding')).toBe('gzip');
		});

		test('HEAD negotiates a variant and returns its headers with a null body', () => {
			const handler = make_asset_handler(variant_asset());
			const res = handler(
				new Request('http://localhost/favicon.png', {
					method: 'HEAD',
					headers: { 'accept-encoding': 'br' }
				})
			);
			expect(res.status).toBe(200);
			expect(res.body).toBeNull();
			expect(res.headers.get('content-encoding')).toBe('br');
			expect(res.headers.get('content-length')).toBe(String(BR_SIZE));
		});

		test('only a br variant present: gzip acceptance still falls through to identity', () => {
			const handler = make_asset_handler(variant_asset({ gz: undefined }));
			const res = handler(
				new Request('http://localhost/favicon.png', {
					headers: { 'accept-encoding': 'gzip' }
				})
			);
			expect(res.headers.get('content-encoding')).toBeNull();
			expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
		});
	});
});

describe('negotiate', () => {
	test('no header returns undefined (identity)', () => {
		expect(negotiate(null, { br: true, gz: true })).toBeUndefined();
	});

	test('no variants available returns undefined regardless of header', () => {
		expect(negotiate('br, gzip', {})).toBeUndefined();
	});

	test('br is preferred when weights are equal', () => {
		expect(negotiate('gzip, br', { br: true, gz: true })).toBe('br');
	});

	test('gzip wins only when its weight is strictly higher than br', () => {
		expect(negotiate('br;q=0.5, gzip;q=0.8', { br: true, gz: true })).toBe('gz');
	});

	test('br wins when its weight is higher', () => {
		expect(negotiate('br;q=0.9, gzip;q=0.2', { br: true, gz: true })).toBe('br');
	});

	test('a wildcard supplies the fallback weight', () => {
		expect(negotiate('*', { br: true, gz: true })).toBe('br');
		expect(negotiate('*;q=0.5, br;q=0', { br: true, gz: true })).toBe('gz');
	});

	test('q=0 refuses that coding', () => {
		expect(negotiate('br;q=0', { br: true, gz: false })).toBeUndefined();
	});

	test('only the available variant is ever chosen', () => {
		expect(negotiate('br, gzip', { br: false, gz: true })).toBe('gz');
		expect(negotiate('br, gzip', { br: true, gz: false })).toBe('br');
	});
});

describe('etag_matches', () => {
	test('returns false with no header', () => {
		expect(etag_matches(null, '"abc"')).toBe(false);
	});

	test('matches the wildcard', () => {
		expect(etag_matches('*', '"abc"')).toBe(true);
	});

	test('matches an exact quoted tag', () => {
		expect(etag_matches('"abc"', '"abc"')).toBe(true);
	});

	test('matches a weak (W/-prefixed) tag', () => {
		expect(etag_matches('W/"abc"', '"abc"')).toBe(true);
	});

	test('matches one entry among a comma-separated list', () => {
		expect(etag_matches('"other", "abc"', '"abc"')).toBe(true);
	});

	test('does not match a different tag', () => {
		expect(etag_matches('"other"', '"abc"')).toBe(false);
	});
});

/** `size` is derived from the bunfs path so a response identifies which file its handler was built from. */
function built_asset(file: string) {
	return { file, size: file.length, etag: file };
}

describe('create_file_map', () => {
	const base_opts = { app_path: '_app', mime_types: { '.html': 'text/html' } };

	test('client assets win a key collision over prerendered assets', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: { '/overlap': built_asset('/bunfs/client') },
			prerendered_assets: { '/overlap': built_asset('/bunfs/prerendered') }
		});

		expect(files.get('/overlap')?.file).toBe('/bunfs/client');
	});

	test('`/foo` and `/foo/` alias to `foo.html`', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: { '/docs.html': built_asset('/bunfs/docs.html') },
			prerendered_assets: {}
		});

		expect(files.get('/docs')?.file).toBe('/bunfs/docs.html');
		expect(files.get('/docs/')?.file).toBe('/bunfs/docs.html');
		expect(files.get('/docs')?.type).toBe('text/html;charset=utf-8');
	});

	test('`/foo` and `/foo/` alias to `foo/index.html` when only that exists', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: { '/guide/index.html': built_asset('/bunfs/guide/index.html') },
			prerendered_assets: {}
		});

		expect(files.get('/guide')?.file).toBe('/bunfs/guide/index.html');
		expect(files.get('/guide/')?.file).toBe('/bunfs/guide/index.html');
	});

	test('`foo.html` claims the alias over `foo/index.html`, sorting first', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: {
				'/both.html': built_asset('/bunfs/both.html'),
				'/both/index.html': built_asset('/bunfs/both/index.html')
			},
			prerendered_assets: {}
		});

		expect(files.get('/both')?.file).toBe('/bunfs/both.html');
	});

	test('an exact file key always wins over an alias', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: {
				'/docs.html': built_asset('/bunfs/docs.html'),
				'/docs': built_asset('/bunfs/docs-real')
			},
			prerendered_assets: {}
		});

		expect(files.get('/docs')?.file).toBe('/bunfs/docs-real');
	});

	test('a root-level index.html does not alias to an empty-string key', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: { '/index.html': built_asset('/bunfs/index.html') },
			prerendered_assets: {}
		});

		expect(files.has('')).toBe(false);
		expect(files.get('/')?.file).toBe('/bunfs/index.html');
	});

	test('prerendered assets are keyed only at their exact path, not aliased', () => {
		const files = create_file_map({
			...base_opts,
			client_assets: {},
			prerendered_assets: { '/about.html': built_asset('/bunfs/about.html') }
		});

		expect(files.has('/about')).toBe(false);
		expect(files.get('/about.html')?.file).toBe('/bunfs/about.html');
	});

	test('a hashed asset under the immutable prefix gets the immutable cache-control', () => {
		const files = create_file_map({
			app_path: '_app',
			mime_types: {},
			client_assets: { '/_app/immutable/chunks/a.js': built_asset('/bunfs/a.js') },
			prerendered_assets: {}
		});

		expect(files.get('/_app/immutable/chunks/a.js')?.cache_control).toBe(
			'public,max-age=31536000,immutable'
		);
	});
});

/**
 * `start()` is where the SvelteKit 3 behaviours are wired together: the route table
 * (manifest MIME types + immutable caching), the relative prerender redirect, the
 * baked-in `paths.origin`, and the SSE opt-outs. The integration specs cover it
 * end to end; these tests pin the same behaviour down cheaply by stubbing `Bun`, so a
 * regression names the exact rule it broke.
 */
describe('start', () => {
	interface ServeOptions {
		hostname: string;
		port: number;
		idleTimeout: number;
		maxRequestBodySize: number;
		fetch: (request: Request, srv: unknown) => Promise<Response>;
	}

	interface Runtime {
		serve: ServeOptions;
		srv: unknown;
		/** `srv.timeout(request, seconds)` calls made by the fetch handler. */
		timeouts: { request: Request; seconds: number }[];
		/** Requests as SvelteKit saw them (after any origin rewrite). */
		responded: Request[];
		/** The `start()` promise itself, so a test can trigger a signal and await shutdown. */
		started: Promise<unknown>;
		dispose: () => void;
	}

	async function start_runtime({
		app_path = '_app',
		mime_types = {},
		client_assets = {},
		prerendered_assets = {},
		prerendered = [],
		respond = async () => new Response('ssr'),
		origin
	}: {
		app_path?: string;
		mime_types?: Record<string, string>;
		client_assets?: Record<string, ReturnType<typeof built_asset>>;
		prerendered_assets?: Record<string, ReturnType<typeof built_asset>>;
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
			// no `size` here: `make_asset_handler` now uses the baked-in `size` from the
			// table entry, not `Bun.file(...).size`
			file: (path: string) => ({
				type: 'application/octet-stream',
				slice: (start_byte: number, end: number) => new Blob([new Uint8Array(end - start_byte)]),
				stream: () => new Blob([new Uint8Array(path.length)]).stream()
			}),
			serve: (options: ServeOptions) => {
				resolve_serve(options);
				return srv;
			}
		});

		const server = {
			async init(_options: unknown) {},
			async respond(request: Request, _options: unknown) {
				responded.push(request);
				return respond(request);
			}
		};

		// `start()` only settles on SIGTERM/SIGINT, so it is deliberately not awaited;
		// the handlers it installs are removed again by `dispose()`.
		const signals = ['SIGTERM', 'SIGINT'] as const;
		const before = new Map(signals.map((s) => [s, new Set(process.listeners(s))]));

		const started = start({
			server: server as never,
			prerendered: new Set(prerendered),
			app_path,
			mime_types,
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
			started,
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

	describe('static asset table', () => {
		test('immutable client assets are cached forever, everything else is not', async () => {
			runtime = await start_runtime({
				client_assets: {
					'/_app/immutable/chunks/app.abc.js': built_asset('/bunfs/app.abc.js'),
					'/_app/version.json': built_asset('/bunfs/version.json'),
					'/favicon.png': built_asset('/bunfs/favicon.png')
				},
				prerendered_assets: { '/about': built_asset('/bunfs/about.html') }
			});

			const cache_control = async (path: string) =>
				(
					await runtime!.serve.fetch(new Request(`http://localhost${path}`), runtime!.srv)
				).headers.get('cache-control');

			expect(await cache_control('/_app/immutable/chunks/app.abc.js')).toBe(
				'public,max-age=31536000,immutable'
			);
			expect(await cache_control('/_app/version.json')).toBeNull();
			expect(await cache_control('/favicon.png')).toBeNull();
			// prerendered pages are regenerated on every deploy, so they must not be immutable
			expect(await cache_control('/about')).toBeNull();
		});

		test('the immutable prefix follows the app path, so it works under paths.base', async () => {
			// with `paths.base = '/app'` `builder.getAppPath()` is `app/_app` and the
			// adapter keys client assets under the same prefix
			runtime = await start_runtime({
				app_path: 'app/_app',
				client_assets: {
					'/app/_app/immutable/chunks/app.abc.js': built_asset('/bunfs/app.abc.js'),
					'/app/_app/version.json': built_asset('/bunfs/version.json')
				}
			});

			const cache_control = async (path: string) =>
				(
					await runtime!.serve.fetch(new Request(`http://localhost${path}`), runtime!.srv)
				).headers.get('cache-control');

			expect(await cache_control('/app/_app/immutable/chunks/app.abc.js')).toBe(
				'public,max-age=31536000,immutable'
			);
			expect(await cache_control('/app/_app/version.json')).toBeNull();
		});

		test('content types come from the manifest for client and prerendered assets alike', async () => {
			runtime = await start_runtime({
				mime_types: { '.jxl': 'image/jxl', '.html': 'text/html' },
				client_assets: {
					'/custom.jxl': built_asset('/bunfs/custom.jxl'),
					'/data.bin': built_asset('/bunfs/data.bin')
				},
				prerendered_assets: { '/about.html': built_asset('/bunfs/about.html') }
			});

			const type = async (path: string) =>
				(
					await runtime!.serve.fetch(new Request(`http://localhost${path}`), runtime!.srv)
				).headers.get('content-type');

			expect(await type('/custom.jxl')).toBe('image/jxl');
			expect(await type('/about.html')).toBe('text/html;charset=utf-8');
			// no manifest entry: Bun's own type for the file is the fallback
			expect(await type('/data.bin')).toBe('application/octet-stream');
		});

		test('client assets win over prerendered assets on key overlap', async () => {
			// mirrors upstream adapter-node's `create_file_map`: prerendered pages are
			// regenerated on every deploy and must not shadow a build asset that happens
			// to share a path
			runtime = await start_runtime({
				client_assets: { '/overlap': built_asset('/bunfs/client') },
				prerendered_assets: { '/overlap': built_asset('/bunfs/prerendered-file') }
			});

			const res = await runtime.serve.fetch(new Request('http://localhost/overlap'), runtime.srv);
			expect(res.headers.get('content-length')).toBe(String('/bunfs/client'.length));
		});

		test('every method other than GET/HEAD on a static asset returns 405, including OPTIONS', async () => {
			runtime = await start_runtime({
				client_assets: { '/favicon.png': built_asset('/bunfs/favicon.png') }
			});

			for (const method of ['OPTIONS', 'POST', 'DELETE']) {
				const res = await runtime.serve.fetch(
					new Request('http://localhost/favicon.png', { method }),
					runtime.srv
				);
				expect(res.status, method).toBe(405);
				expect(res.headers.get('allow'), method).toBe('GET, HEAD');
			}
		});

		describe('clean-URL aliases for client .html files', () => {
			test('`/foo` and `/foo/` resolve to `foo.html`', async () => {
				runtime = await start_runtime({
					mime_types: { '.html': 'text/html' },
					client_assets: { '/docs.html': built_asset('/bunfs/docs.html') }
				});

				for (const path of ['/docs', '/docs/']) {
					const res = await runtime.serve.fetch(
						new Request(`http://localhost${path}`),
						runtime.srv
					);
					expect(res.status, path).toBe(200);
					expect(res.headers.get('content-length'), path).toBe(String('/bunfs/docs.html'.length));
				}
			});

			test('`/foo` and `/foo/` resolve to `foo/index.html` when only that exists', async () => {
				runtime = await start_runtime({
					mime_types: { '.html': 'text/html' },
					client_assets: { '/guide/index.html': built_asset('/bunfs/guide/index.html') }
				});

				for (const path of ['/guide', '/guide/']) {
					const res = await runtime.serve.fetch(
						new Request(`http://localhost${path}`),
						runtime.srv
					);
					expect(res.status, path).toBe(200);
					expect(res.headers.get('content-length'), path).toBe(
						String('/bunfs/guide/index.html'.length)
					);
				}
			});

			test('`foo.html` claims the alias over `foo/index.html` when both exist', async () => {
				runtime = await start_runtime({
					mime_types: { '.html': 'text/html' },
					client_assets: {
						'/both.html': built_asset('/bunfs/both.html'),
						'/both/index.html': built_asset('/bunfs/both/index.html')
					}
				});

				const res = await runtime.serve.fetch(new Request('http://localhost/both'), runtime.srv);
				expect(res.headers.get('content-length')).toBe(String('/bunfs/both.html'.length));
			});

			test('an exact file key always wins over an alias', async () => {
				runtime = await start_runtime({
					mime_types: { '.html': 'text/html' },
					client_assets: {
						'/docs.html': built_asset('/bunfs/docs.html'),
						// a real file that happens to collide with the alias `/docs.html` would derive
						'/docs': built_asset('/bunfs/docs-real')
					}
				});

				const res = await runtime.serve.fetch(new Request('http://localhost/docs'), runtime.srv);
				expect(res.headers.get('content-length')).toBe(String('/bunfs/docs-real'.length));
			});

			test('prerendered pages are not given clean-URL aliases beyond their exact path', async () => {
				runtime = await start_runtime({
					prerendered_assets: { '/about.html': built_asset('/bunfs/about.html') },
					respond: async () => new Response('ssr')
				});

				// `/about` is not a client `.html` alias target, so it must fall through to SSR
				const res = await runtime.serve.fetch(new Request('http://localhost/about'), runtime.srv);
				expect(await res.text()).toBe('ssr');
			});
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

		test('without an origin the request is rewritten to https (the derived default)', async () => {
			runtime = await start_runtime();

			const request = new Request('http://127.0.0.1:3000/deep');
			await runtime.serve.fetch(request, runtime.srv);
			// the incoming request is plain http (Bun's socket URL), but with no
			// PROTOCOL_HEADER configured the derived origin defaults to https, so
			// SvelteKit must see a *different* request object with that origin
			expect(runtime.responded[0]).not.toBe(request);
			// derived from url.host (not url.hostname), so the port is preserved, same
			// as upstream falling back to the raw `host` header
			expect(runtime.responded[0].url).toBe('https://127.0.0.1:3000/deep');
		});

		test('a static asset is served before origin resolution runs', async () => {
			// a malformed proxy header would 400 an SSR request (see below), but a static
			// asset must still be served — mirrors upstream's static middleware running
			// ahead of the SvelteKit handler
			vi.stubEnv('PROTOCOL_HEADER', 'x-forwarded-proto');
			runtime = await start_runtime({
				client_assets: { '/favicon.png': built_asset('/bunfs/favicon.png') }
			});

			const res = await runtime.serve.fetch(
				new Request('http://localhost/favicon.png', {
					headers: { 'x-forwarded-proto': 'https://evil.com' }
				}),
				runtime.srv
			);
			expect(res.status).toBe(200);
			expect(runtime.responded).toHaveLength(0);
		});

		test('an invalid proxy header fails the request with 400 instead of the generic 500, and logs why', async () => {
			vi.stubEnv('PROTOCOL_HEADER', 'x-forwarded-proto');
			runtime = await start_runtime();

			// `vi.spyOn(process.stderr, 'write')` is a silent no-op in this Bun +
			// Vitest setup (records nothing, throws nothing) — reassign the method
			// directly and restore it afterwards.
			const original_write = process.stderr.write;
			const calls: unknown[][] = [];
			process.stderr.write = ((...args: unknown[]) => {
				calls.push(args);
				return true;
			}) as typeof process.stderr.write;
			let res: Response;
			try {
				res = await runtime.serve.fetch(
					new Request('http://127.0.0.1:3000/deep', {
						headers: { 'x-forwarded-proto': 'https://evil.com' }
					}),
					runtime.srv
				);
			} finally {
				process.stderr.write = original_write;
			}

			expect(res.status).toBe(400);
			// SvelteKit is never asked once the origin can't be determined
			expect(runtime.responded).toHaveLength(0);
			expect(calls.map((call) => call[0])).toContainEqual(
				expect.stringMatching(
					/Could not determine request origin: .*includes `:`.*It should only contain the protocol scheme/
				)
			);
		});

		test('a comma-joined proxy header value also fails the request with 400, and logs why', async () => {
			vi.stubEnv('HOST_HEADER', 'x-forwarded-host');
			runtime = await start_runtime();

			const original_write = process.stderr.write;
			const calls: unknown[][] = [];
			process.stderr.write = ((...args: unknown[]) => {
				calls.push(args);
				return true;
			}) as typeof process.stderr.write;
			let res: Response;
			try {
				res = await runtime.serve.fetch(
					new Request('http://127.0.0.1:3000/deep', {
						headers: { 'x-forwarded-host': 'a.com, b.com' }
					}),
					runtime.srv
				);
			} finally {
				process.stderr.write = original_write;
			}

			expect(res.status).toBe(400);
			expect(runtime.responded).toHaveLength(0);
			expect(calls.map((call) => call[0])).toContainEqual(
				expect.stringMatching(/Could not determine request origin: Multiple values provided/)
			);
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
		const server = {
			async init() {
				initialised = true;
			},
			async respond() {
				return new Response('');
			}
		};

		await expect(
			start({
				server: server as never,
				prerendered: new Set(),
				app_path: '_app',
				mime_types: {},
				client_assets: {},
				prerendered_assets: {},
				server_assets: {}
			})
		).rejects.toThrow(/PORT must be an integer/);
		expect(initialised).toBe(false);
	});

	describe('SOCKET_PATH', () => {
		test('binds Bun.serve to the unix socket instead of host/port', async () => {
			vi.stubEnv('SOCKET_PATH', '/tmp/adapter-bun-test.sock');
			vi.stubEnv('CONNECTION_IDLE_TIMEOUT', '7');
			runtime = await start_runtime();

			// `idleTimeout` is still passed: Bun honours it on unix sockets too, and
			// without it Bun's 10s default would come back for `SOCKET_PATH` listeners
			const serve = runtime.serve as unknown as {
				unix?: string;
				hostname?: string;
				port?: number;
				idleTimeout?: number;
			};
			expect(serve.unix).toBe('/tmp/adapter-bun-test.sock');
			expect(serve.hostname).toBeUndefined();
			expect(serve.port).toBeUndefined();
			expect(serve.idleTimeout).toBe(7);
		});
	});

	describe('sveltekit:shutdown', () => {
		test.each(['SIGTERM', 'SIGINT'] as const)(
			'is emitted once, with %s as the reason, after shutdown completes',
			async (signal) => {
				runtime = await start_runtime();

				const reasons: unknown[] = [];
				const on_shutdown = (reason: unknown) => reasons.push(reason);
				process.once('sveltekit:shutdown', on_shutdown);

				try {
					// mirrors how Node itself invokes a signal listener: with the
					// signal name as the sole argument
					process.emit(signal, signal);
					await runtime.started;
				} finally {
					process.removeListener('sveltekit:shutdown', on_shutdown);
				}

				expect(reasons).toEqual([signal]);
			}
		);
	});
});
