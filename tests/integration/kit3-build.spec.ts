import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	build_fixture,
	repo_root,
	start_app,
	stop_app,
	type SpawnedServer
} from '../helpers/fixture.js';

const CONFIGURED_ORIGIN = 'https://configured.example.com';

/**
 * End-to-end smoke test of a SvelteKit 3 build: `kit.paths.origin` replaced the
 * adapter-level `ORIGIN` environment variable, so the origin has to be baked into
 * the generated entry at build time and honored at runtime.
 */
describe('SvelteKit 3 build', () => {
	test('the adapter uses no deprecated builder APIs', () => {
		const source = readFileSync(join(repo_root, 'index.js'), 'utf8');
		expect(source).not.toMatch(/builder\.rimraf/);
		expect(source).not.toMatch(/builder\.mkdirp/);
	});

	test('the runtime no longer reads an ORIGIN environment variable', () => {
		const source = readFileSync(join(repo_root, 'files/serve.js'), 'utf8');
		expect(source).not.toContain('ORIGIN');
	});

	describe('with kit.paths.origin configured', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';
		let entry = '';

		beforeAll(async () => {
			const out = build_fixture({
				out: 'build-origin',
				origin: CONFIGURED_ORIGIN,
				compile: false
			});
			entry = readFileSync(join(out, 'entry.js'), 'utf8');

			// a stray ORIGIN in the environment must not influence the resolved origin
			({ base_url, server } = await start_app(['bun', join(out, 'entry.js')], {
				env: { ORIGIN: 'https://from-env.example.com' },
				label: 'origin-app'
			}));
		}, 180_000);

		afterAll(() => stop_app(server));

		test('bakes the origin into the generated entry', () => {
			expect(entry).toContain(`origin: ${JSON.stringify(CONFIGURED_ORIGIN)}`);
		});

		test('kit.paths.origin determines the request origin', async () => {
			const res = await fetch(`${base_url}/origin`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(CONFIGURED_ORIGIN);
		});

		test('ORIGIN in the environment does not affect the request origin', async () => {
			const res = await fetch(`${base_url}/origin`);
			expect(await res.text()).not.toContain('from-env');
		});
	});

	describe('with kit.paths.origin unset', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';
		let entry = '';

		beforeAll(async () => {
			const out = build_fixture({ out: 'build-no-origin', compile: false });
			entry = readFileSync(join(out, 'entry.js'), 'utf8');

			({ base_url, server } = await start_app(['bun', join(out, 'entry.js')], {
				env: { ORIGIN: 'https://from-env.example.com' },
				label: 'no-origin-app'
			}));
		}, 180_000);

		afterAll(() => stop_app(server));

		test('omits origin from the generated entry', () => {
			expect(entry).not.toContain('origin:');
		});

		test('falls back to the request-derived origin', async () => {
			const res = await fetch(`${base_url}/origin`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(base_url);
		});
	});
});
