import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build_fixture, start_app, stop_app, type SpawnedServer } from '../helpers/fixture.js';

/**
 * Every response rule the adapter applies keys off a path that contains
 * `paths.base`: the immutable cache header is derived from `builder.getAppPath()`
 * (which SvelteKit builds as `<base>/<appDir>`), MIME types are looked up per
 * asset URL, and the prerender slash redirect is relative. A base path is the case
 * where a mismatch between the adapter's asset keys and the app path would go
 * unnoticed, so it gets its own compiled executable.
 */
const BASE = '/app';

describe('a compiled app built with paths.base', () => {
	let server: SpawnedServer | null = null;
	let base_url = '';
	let out = '';

	beforeAll(async () => {
		// `precompress: false` shares this build too, rather than compiling a
		// dedicated executable — see the assertions at the bottom of this file.
		out = build_fixture({ out: 'build-base', base: BASE, precompress: false });
		({ base_url, server } = await start_app([join(out, 'app')], { label: 'base-path-app' }));
	}, 240_000);

	afterAll(() => stop_app(server));

	/** Absolute `/app/...` URL for a path inside the app. */
	const url = (path: string) => `${base_url}${BASE}${path}`;

	test('the prerendered page is served under the base path', async () => {
		const res = await fetch(url('/about'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/html;charset=utf-8');
		expect(await res.text()).toContain('About (prerendered)');
	});

	test('the SSR entry page is served under the base path', async () => {
		const res = await fetch(url('/'));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<h1');
	});

	test('hashed assets under <base>/_app/immutable are cached forever', async () => {
		const html = await fetch(url('/assets')).then((r) => r.text());
		const hashed = [
			...html.matchAll(/(?:src|href)="((?:\.\/|\/app\/)_app\/immutable\/[^"]+)"/g)
		].map(([, ref]) => (ref.startsWith('./') ? `${BASE}/${ref.slice(2)}` : ref));
		expect(hashed.length).toBeGreaterThan(0);

		for (const path of hashed) {
			expect(path.startsWith(`${BASE}/_app/immutable/`), path).toBe(true);
			const res = await fetch(`${base_url}${path}`);
			await res.arrayBuffer();
			expect(res.status, path).toBe(200);
			expect(res.headers.get('cache-control'), path).toBe('public,max-age=31536000,immutable');
		}
	});

	test('non-hashed assets under the base path are not cached forever', async () => {
		for (const path of ['/favicon.png', '/_app/version.json']) {
			const res = await fetch(url(path));
			await res.arrayBuffer();
			expect(res.status, path).toBe(200);
			expect(res.headers.get('cache-control') ?? '', path).not.toMatch(/immutable/);
		}
	});

	test('manifest MIME types are applied to assets under the base path', async () => {
		const res = await fetch(url('/custom.jxl'));
		await res.arrayBuffer();
		expect(res.status).toBe(200);
		// Bun would report application/octet-stream for `.jxl`
		expect(res.headers.get('content-type')).toBe('image/jxl');
	});

	test('the prerender slash redirect stays relative, so it resolves inside the base path', async () => {
		const manual = await fetch(url('/about/'), { redirect: 'manual' });
		await manual.arrayBuffer();
		expect(manual.status).toBe(308);
		expect(manual.headers.get('location')).toBe('../about');

		// an absolute `/about` would have escaped the base path and 404ed
		const followed = await fetch(url('/about/'));
		expect(followed.status).toBe(200);
		expect(new URL(followed.url).pathname).toBe(`${BASE}/about`);
		expect(await followed.text()).toContain('About (prerendered)');
	});

	test('paths outside the base are not served by the app', async () => {
		const res = await fetch(`${base_url}/about`);
		await res.arrayBuffer();
		expect(res.status).toBe(404);
	});

	test('precompress: false never negotiates a compressed representation', async () => {
		const res = await fetch(url('/extra.css'), { headers: { 'accept-encoding': 'br, gzip' } });
		await res.arrayBuffer();
		expect(res.status).toBe(200);
		expect(res.headers.get('content-encoding')).toBeNull();
		expect(res.headers.get('vary')).toBeNull();
	});

	test('precompress: false embeds no .br/.gz variants in the generated entry', () => {
		const entry_source = readFileSync(join(out, 'entry.js'), 'utf8');
		expect(entry_source).not.toContain('.br"');
		expect(entry_source).not.toContain('.gz"');
	});
});
