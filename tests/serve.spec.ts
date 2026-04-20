import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	get_client_address,
	make_asset_handler,
	parse_as_bytes,
	parse_origin,
	resolve_origin
} from '../files/serve.js';

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

describe('parse_origin', () => {
	test.each([
		['http://localhost:3000', 'http://localhost:3000'],
		['https://example.com', 'https://example.com'],
		['http://192.168.1.1:8080', 'http://192.168.1.1:8080'],
		['http://localhost', 'http://localhost'],
		// WHATWG URL normalizes default ports
		['https://example.com:443', 'https://example.com'],
		['http://example.com:80', 'http://example.com']
	] as const)('normalizes %s to %s', (input, expected) => {
		expect(parse_origin(input, 'ORIGIN')).toBe(expected);
	});

	test.each([
		['http://localhost:3000/path', 'http://localhost:3000'],
		['http://localhost:3000?query=1', 'http://localhost:3000'],
		['http://localhost:3000#hash', 'http://localhost:3000'],
		['https://example.com:443/path?query=1#hash', 'https://example.com']
	] as const)('strips path/query/hash from %s → %s', (input, expected) => {
		expect(parse_origin(input, 'ORIGIN')).toBe(expected);
	});

	test('trims surrounding whitespace', () => {
		expect(parse_origin('  http://localhost:3000  ', 'ORIGIN')).toBe('http://localhost:3000');
	});

	test('returns undefined when value is undefined', () => {
		expect(parse_origin(undefined, 'ORIGIN')).toBeUndefined();
	});

	test.each([
		'localhost:3000',
		'example.com',
		'',
		'   ',
		'ftp://localhost:3000',
		'file:///etc'
	] as const)('throws on invalid origin: %s', (input) => {
		expect(() => parse_origin(input, 'ORIGIN')).toThrow(/Invalid ORIGIN/);
	});

	test('embeds custom env_name in error', () => {
		expect(() => parse_origin('not a url', 'MY_ORIGIN')).toThrow(/Invalid MY_ORIGIN/);
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

	test('short-circuits to origin_env when set', () => {
		const req = make_request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.com' });
		const url = new URL(req.url);
		expect(
			resolve_origin(req, url, {
				...base_cfg,
				origin_env: 'https://example.com',
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
		const null_srv = { requestIP: () => null } as unknown as import('bun').Server<unknown>;
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
