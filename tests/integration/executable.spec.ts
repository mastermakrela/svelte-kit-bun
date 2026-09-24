import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
	build_fixture,
	fixture,
	start_app,
	stop_app,
	type SpawnedServer
} from '../helpers/fixture.js';

/**
 * `fetch` (undici) auto-decompresses `gzip`/`br` bodies transparently, which would
 * make a "decompresses to the original bytes" assertion pass even if the server sent
 * the identity representation. A raw `node:http` request sidesteps that: it never sets
 * `Accept-Encoding` on its own and hands back the exact bytes on the wire.
 */
function raw_request(
	url: string,
	headers: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks)
				})
			);
		});
		req.on('error', reject);
		req.end();
	});
}

const binary = join(fixture, 'build/app');

let server: SpawnedServer | null = null;
let base_url = '';

beforeAll(async () => {
	build_fixture();
	if (!existsSync(binary)) {
		throw new Error(`expected compiled binary at ${binary}`);
	}

	({ base_url, server } = await start_app([binary]));
}, 180_000);

afterAll(() => stop_app(server));

/** Normalize a ref that may be `./foo` or `/foo` to an absolute URL path `/foo`. */
function abs(ref: string): string {
	if (ref.startsWith('./')) return '/' + ref.slice(2);
	if (!ref.startsWith('/')) return '/' + ref;
	return ref;
}

describe('compiled executable bundling', () => {
	test('prerendered /about is served as HTML', async () => {
		const res = await fetch(`${base_url}/about`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
		const body = await res.text();
		expect(body).toContain('About (prerendered)');
	});

	test('SSR route / renders', async () => {
		const res = await fetch(`${base_url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
	});

	test('static/favicon.png is bundled and served with image/png', async () => {
		const on_disk = readFileSync(join(fixture, 'static/favicon.png'));
		const res = await fetch(`${base_url}/favicon.png`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/image\/png/);
		expect(res.headers.get('content-length')).toBe(String(on_disk.byteLength));
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.byteLength).toBe(on_disk.byteLength);
		expect(Buffer.from(bytes).equals(on_disk)).toBe(true);
	});

	test('static/extra.css is bundled and served with text/css', async () => {
		const res = await fetch(`${base_url}/extra.css`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/css/);
		expect(await res.text()).toContain('static-css-marker');
	});

	test('static/hello.txt is served as text/plain', async () => {
		const res = await fetch(`${base_url}/hello.txt`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/plain/);
		expect(await res.text()).toContain('static passthrough');
	});

	test('/assets renders, references imported images + inlines ?raw markdown', async () => {
		const res = await fetch(`${base_url}/assets`);
		expect(res.status).toBe(200);
		const html = await res.text();

		// component style emitted hashed CSS
		const css_hrefs = [
			...html.matchAll(/href="((?:\/|\.\/)_app\/immutable\/assets\/[^"]+\.css)"/g)
		].map((m) => m[1]);
		expect(css_hrefs.length).toBeGreaterThan(0);

		// imported SVG and PNG assets resolved to hashed URLs
		const img_srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
		const svg_hashed = img_srcs.find((s) =>
			/(?:\/|\.\/)_app\/immutable\/assets\/logo\.[^"]*\.svg$/.test(s)
		);
		const png_hashed = img_srcs.find((s) =>
			/(?:\/|\.\/)_app\/immutable\/assets\/pixel\.[^"]*\.png$/.test(s)
		);
		expect(svg_hashed, `expected a hashed logo.svg in ${img_srcs.join(', ')}`).toBeTruthy();
		expect(png_hashed, `expected a hashed pixel.png in ${img_srcs.join(', ')}`).toBeTruthy();

		// ?raw import inlined into server HTML output
		expect(html).toContain('Sample markdown');
		expect(html).toContain('?raw');

		// ?url import rendered as a URL (either original path or hashed)
		const greeting_match = html.match(/<a\b[^>]*data-testid="greeting-url"[^>]*>/);
		expect(greeting_match?.[0], 'missing greeting-url anchor').toMatch(/href="[^"]+\.txt"/);

		// static/extra.css linked via svelte:head
		expect(html).toMatch(/<link[^>]+href="\/extra\.css"/);

		return { css_hrefs, svg_hashed, png_hashed };
	});

	test('component-emitted CSS chunk is served', async () => {
		const html = await fetch(`${base_url}/assets`).then((r) => r.text());
		const css_href = html.match(/href="((?:\/|\.\/)_app\/immutable\/assets\/[^"]+\.css)"/)?.[1];
		expect(css_href).toBeTruthy();

		const res = await fetch(`${base_url}${abs(css_href!)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/css/);
		const body = await res.text();
		expect(body).toContain('assets-marker');
		// url() reference to a static asset is preserved
		expect(body).toContain('/favicon.png');
	});

	test('imported SVG asset is served with image/svg+xml', async () => {
		const html = await fetch(`${base_url}/assets`).then((r) => r.text());
		const svg_href = html.match(
			/src="((?:\/|\.\/)_app\/immutable\/assets\/logo\.[^"]*\.svg)"/
		)?.[1];
		expect(svg_href).toBeTruthy();

		const res = await fetch(`${base_url}${abs(svg_href!)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/image\/svg/);
		expect(await res.text()).toContain('<svg');
	});

	test('imported PNG asset is served with image/png and correct bytes', async () => {
		const html = await fetch(`${base_url}/assets`).then((r) => r.text());
		const png_href = html.match(
			/src="((?:\/|\.\/)_app\/immutable\/assets\/pixel\.[^"]*\.png)"/
		)?.[1];
		expect(png_href).toBeTruthy();

		const on_disk = readFileSync(join(fixture, 'src/lib/pixel.png'));
		const res = await fetch(`${base_url}${abs(png_href!)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/image\/png/);
		expect(res.headers.get('content-length')).toBe(String(on_disk.byteLength));
		expect(Buffer.from(await res.arrayBuffer()).equals(on_disk)).toBe(true);
	});

	test('server-side read() asset (/greeting) still works alongside client assets', async () => {
		const res = await fetch(`${base_url}/greeting`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/plain/);
		expect(await res.text()).toContain('embedded text file');
	});

	test('Range request on bundled image returns 206 with correct slice', async () => {
		const on_disk = readFileSync(join(fixture, 'static/favicon.png'));
		const res = await fetch(`${base_url}/favicon.png`, {
			headers: { range: 'bytes=0-15' }
		});
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 0-15/${on_disk.byteLength}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.byteLength).toBe(16);
		expect(Buffer.from(bytes).equals(on_disk.subarray(0, 16))).toBe(true);
	});
});

describe('without a server instrumentation file', () => {
	test('the entry is not instrumented and no instrumentation runs', async () => {
		expect(readFileSync(join(fixture, 'build/entry.js'), 'utf8')).toContain('await start({');

		const res = await fetch(`${base_url}/instrumentation`);
		expect(await res.json()).toEqual({ order: ['app'], marker: null, env: null });
	});
});

// Parity with `@sveltejs/adapter-node`'s `handler.js`.
describe('response semantics', () => {
	test('static MIME type comes from the manifest, not Bun’s extension mapping', async () => {
		// `Bun.file('*.jxl').type` is `application/octet-stream`; SvelteKit's manifest
		// records `image/jxl`, so this only passes if the manifest is the source of truth.
		const res = await fetch(`${base_url}/custom.jxl`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/jxl');
	});

	test('static MIME types equal the build’s `builder.mimeTypes` exactly', async () => {
		const manifest_source = readFileSync(join(fixture, 'build/server/manifest.js'), 'utf8');
		const mime_types = JSON.parse(
			manifest_source.match(/^export const mime_types = (\{.*\});$/m)![1]
		) as Record<string, string>;
		expect(mime_types['.jxl']).toBe('image/jxl');

		for (const [path, ext] of [
			['/favicon.png', '.png'],
			['/extra.css', '.css'],
			['/hello.txt', '.txt'],
			['/custom.jxl', '.jxl']
		] as const) {
			const res = await fetch(`${base_url}${path}`);
			await res.arrayBuffer();
			expect(res.headers.get('content-type'), path).toBe(mime_types[ext]);
		}
	});

	test('immutable client assets get a long-lived immutable cache-control', async () => {
		const html = await fetch(`${base_url}/assets`).then((r) => r.text());
		const css_href = html.match(/href="((?:\/|\.\/)_app\/immutable\/assets\/[^"]+\.css)"/)?.[1];
		expect(css_href).toBeTruthy();

		const res = await fetch(`${base_url}${abs(css_href!)}`);
		await res.arrayBuffer();
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public,max-age=31536000,immutable');
	});

	test('non-immutable client assets are not cached forever', async () => {
		for (const path of ['/favicon.png', '/_app/version.json']) {
			const res = await fetch(`${base_url}${path}`);
			await res.arrayBuffer();
			expect(res.status, path).toBe(200);
			expect(res.headers.get('cache-control') ?? '', path).not.toMatch(/immutable/);
		}
	});

	test('prerendered slash redirect uses a relative location (survives a stripped proxy prefix)', async () => {
		const res = await fetch(`${base_url}/about/`, { redirect: 'manual' });
		await res.arrayBuffer();
		expect(res.status).toBe(308);
		// relative, so a proxy mounted at e.g. `/app` resolves it to `/app/about`
		expect(res.headers.get('location')).toBe('../about');
	});

	test('prerendered slash redirect keeps the query string', async () => {
		const res = await fetch(`${base_url}/about/?q=1&x=2`, { redirect: 'manual' });
		await res.arrayBuffer();
		expect(res.status).toBe(308);
		expect(res.headers.get('location')).toBe('../about?q=1&x=2');
	});

	test('relative slash redirect resolves back to the prerendered page', async () => {
		const res = await fetch(`${base_url}/about/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('About (prerendered)');
	});

	test('SSE responses opt out of nginx-style buffering', async () => {
		const res = await fetch(`${base_url}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('x-accel-buffering')).toBe('no');
		expect(await res.text()).toContain('data: tick 0');
	});

	test('non-streaming responses do not get x-accel-buffering', async () => {
		const res = await fetch(`${base_url}/`);
		await res.arrayBuffer();
		expect(res.headers.get('x-accel-buffering')).toBeNull();
	});
});

// Static-asset semantics parity with `@sveltejs/adapter-node`'s `static.js`.
describe('static asset semantics', () => {
	test('OPTIONS on a static asset returns 405 with allow: GET, HEAD', async () => {
		const res = await fetch(`${base_url}/favicon.png`, { method: 'OPTIONS' });
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('GET, HEAD');
	});

	test('POST on a static asset returns 405', async () => {
		const res = await fetch(`${base_url}/favicon.png`, { method: 'POST' });
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('GET, HEAD');
	});

	test('a dotfile in static/ is not served, even though it is on disk', async () => {
		expect(existsSync(join(fixture, 'static/.hidden'))).toBe(true);
		const res = await fetch(`${base_url}/.hidden`);
		expect(res.status).toBe(404);
	});

	test('static/.hidden is not embedded in the compiled executable', () => {
		const source = readFileSync(join(fixture, 'build/entry.js'), 'utf8');
		expect(source).not.toContain('.hidden');
	});

	test('a dotfile under .well-known/ is served', async () => {
		const res = await fetch(`${base_url}/.well-known/x.txt`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('well-known-content');
	});

	test('a static asset response carries an ETag', async () => {
		const res = await fetch(`${base_url}/favicon.png`);
		await res.arrayBuffer();
		expect(res.headers.get('etag')).toMatch(/^"[\w-]+"$/);
	});

	test('a matching If-None-Match returns 304 with etag + cache-control only', async () => {
		const first = await fetch(`${base_url}/favicon.png`);
		await first.arrayBuffer();
		const etag = first.headers.get('etag')!;
		expect(etag).toBeTruthy();

		const res = await fetch(`${base_url}/favicon.png`, { headers: { 'if-none-match': etag } });
		expect(res.status).toBe(304);
		expect(res.headers.get('etag')).toBe(etag);
		expect(res.headers.get('content-length')).toBeNull();
		const body = await res.arrayBuffer();
		expect(body.byteLength).toBe(0);
	});

	test('a non-matching If-None-Match returns the full 200', async () => {
		const res = await fetch(`${base_url}/favicon.png`, {
			headers: { 'if-none-match': '"not-the-real-etag"' }
		});
		expect(res.status).toBe(200);
	});

	test('a Range end beyond size - 1 is clamped to a 206, not rejected with 416', async () => {
		const on_disk = readFileSync(join(fixture, 'static/favicon.png'));
		const res = await fetch(`${base_url}/favicon.png`, {
			headers: { range: `bytes=0-${on_disk.byteLength * 2}` }
		});
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(
			`bytes 0-${on_disk.byteLength - 1}/${on_disk.byteLength}`
		);
	});

	test('a suffix Range (bytes=-N) returns the last N bytes', async () => {
		const on_disk = readFileSync(join(fixture, 'static/favicon.png'));
		const res = await fetch(`${base_url}/favicon.png`, { headers: { range: 'bytes=-10' } });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(
			`bytes ${on_disk.byteLength - 10}-${on_disk.byteLength - 1}/${on_disk.byteLength}`
		);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(Buffer.from(bytes).equals(on_disk.subarray(on_disk.byteLength - 10))).toBe(true);
	});

	test('a stale If-Range returns the full response instead of the requested range', async () => {
		const on_disk = readFileSync(join(fixture, 'static/favicon.png'));
		const res = await fetch(`${base_url}/favicon.png`, {
			headers: { range: 'bytes=0-9', 'if-range': '"stale-etag"' }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(on_disk.byteLength));
	});

	test('a matching If-Range honours the Range request', async () => {
		const first = await fetch(`${base_url}/favicon.png`);
		await first.arrayBuffer();
		const etag = first.headers.get('etag')!;

		const res = await fetch(`${base_url}/favicon.png`, {
			headers: { range: 'bytes=0-9', 'if-range': etag }
		});
		expect(res.status).toBe(206);
	});

	test('`/docs` and `/docs/` resolve to static/docs.html', async () => {
		for (const path of ['/docs', '/docs/']) {
			const res = await fetch(`${base_url}${path}`);
			expect(res.status, path).toBe(200);
			expect(await res.text()).toContain('Docs');
		}
	});

	test('`/guide` and `/guide/` resolve to static/guide/index.html when there is no guide.html', async () => {
		for (const path of ['/guide', '/guide/']) {
			const res = await fetch(`${base_url}${path}`);
			expect(res.status, path).toBe(200);
			expect(await res.text()).toContain('Guide index');
		}
	});

	test('`both.html` claims the clean-URL alias over `both/index.html`', async () => {
		const res = await fetch(`${base_url}/both`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('both.html wins');
	});
});

// The default build has `precompress: true` (the default), so this fixture's own
// compressible static assets (extra.css, hello.txt) exercise real Accept-Encoding
// negotiation end to end. `precompress: false` is covered by base-path.spec.ts,
// which reuses its own build rather than compiling a dedicated one here.
describe('precompression (Accept-Encoding negotiation)', () => {
	test('br-negotiated /extra.css decompresses to the on-disk bytes', async () => {
		const on_disk = readFileSync(join(fixture, 'static/extra.css'));
		const res = await raw_request(`${base_url}/extra.css`, { 'accept-encoding': 'br' });

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('br');
		expect(res.headers['vary']).toBe('Accept-Encoding');
		expect(res.headers['etag']).toMatch(/^"[\w-]+\.br"$/);
		expect(brotliDecompressSync(res.body).equals(on_disk)).toBe(true);
	});

	test('gzip-negotiated /hello.txt decompresses to the on-disk bytes', async () => {
		const on_disk = readFileSync(join(fixture, 'static/hello.txt'));
		const res = await raw_request(`${base_url}/hello.txt`, { 'accept-encoding': 'gzip' });

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('gzip');
		expect(res.headers['etag']).toMatch(/^"[\w-]+\.gz"$/);
		expect(gunzipSync(res.body).equals(on_disk)).toBe(true);
	});

	test('br is preferred over gzip when both are acceptable', async () => {
		const res = await raw_request(`${base_url}/extra.css`, { 'accept-encoding': 'gzip, br' });
		expect(res.headers['content-encoding']).toBe('br');
	});

	test('no Accept-Encoding header serves the identity representation, still advertising Vary', async () => {
		const on_disk = readFileSync(join(fixture, 'static/extra.css'));
		const res = await raw_request(`${base_url}/extra.css`, {});

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBeUndefined();
		expect(res.headers['vary']).toBe('Accept-Encoding');
		expect(res.body.equals(on_disk)).toBe(true);
	});

	test('favicon.png is not a compressible extension, so it is never negotiated', async () => {
		const res = await raw_request(`${base_url}/favicon.png`, { 'accept-encoding': 'br, gzip' });

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBeUndefined();
		expect(res.headers['vary']).toBeUndefined();
	});
});
