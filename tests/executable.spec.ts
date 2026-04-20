import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, 'fixtures/basic-app');
const binary = join(fixture, 'build/app');

/** Find a free TCP port by opening an ephemeral listener and reading its address. */
function free_port(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close();
				reject(new Error('no port'));
				return;
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

async function wait_for_http(url: string, timeout_ms: number) {
	const deadline = Date.now() + timeout_ms;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(500) });
			await res.arrayBuffer();
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`server did not become ready at ${url} within ${timeout_ms}ms`);
}

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let base_url = '';

beforeAll(async () => {
	rmSync(join(fixture, 'build'), { recursive: true, force: true });
	rmSync(join(fixture, '.svelte-kit'), { recursive: true, force: true });

	const build = spawnSync('bun', ['run', 'build'], {
		cwd: fixture,
		stdio: 'inherit'
	});
	if (build.status !== 0) {
		throw new Error(`bun run build failed (status ${build.status})`);
	}
	if (!existsSync(binary)) {
		throw new Error(`expected compiled binary at ${binary}`);
	}

	const port = await free_port();
	base_url = `http://127.0.0.1:${port}`;
	server = spawn(binary, [], {
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', (b) => process.stdout.write(`[app stdout] ${b}`));
	server.stderr.on('data', (b) => process.stderr.write(`[app stderr] ${b}`));

	await wait_for_http(`${base_url}/about`, 15_000);
}, 180_000);

afterAll(async () => {
	if (!server) return;
	server.kill('SIGTERM');
	await new Promise((r) => setTimeout(r, 100));
	if (server.exitCode === null) server.kill('SIGKILL');
});

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
		const css_hrefs = [...html.matchAll(/href="((?:\/|\.\/)_app\/immutable\/assets\/[^"]+\.css)"/g)].map(
			(m) => m[1]
		);
		expect(css_hrefs.length).toBeGreaterThan(0);

		// imported SVG and PNG assets resolved to hashed URLs
		const img_srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
		const svg_hashed = img_srcs.find((s) => /(?:\/|\.\/)_app\/immutable\/assets\/logo\.[^"]*\.svg$/.test(s));
		const png_hashed = img_srcs.find((s) => /(?:\/|\.\/)_app\/immutable\/assets\/pixel\.[^"]*\.png$/.test(s));
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
		const svg_href = html.match(/src="((?:\/|\.\/)_app\/immutable\/assets\/logo\.[^"]*\.svg)"/)?.[1];
		expect(svg_href).toBeTruthy();

		const res = await fetch(`${base_url}${abs(svg_href!)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/image\/svg/);
		expect(await res.text()).toContain('<svg');
	});

	test('imported PNG asset is served with image/png and correct bytes', async () => {
		const html = await fetch(`${base_url}/assets`).then((r) => r.text());
		const png_href = html.match(/src="((?:\/|\.\/)_app\/immutable\/assets\/pixel\.[^"]*\.png)"/)?.[1];
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
