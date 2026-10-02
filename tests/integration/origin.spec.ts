import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { build_fixture, start_app, stop_app, type SpawnedServer } from '../helpers/fixture.js';

/**
 * SvelteKit 2 has no `paths.origin`, so — as in `@sveltejs/adapter-node@5` — the
 * public origin comes from the `ORIGIN` environment variable at runtime, and is
 * derived from the request when unset.
 */
describe('request origin', () => {
	let out = '';

	beforeAll(() => {
		out = build_fixture({ out: 'build-origin', compile: false });
	}, 180_000);

	describe('with ORIGIN set', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';

		beforeAll(async () => {
			({ base_url, server } = await start_app(['bun', join(out, 'entry.js')], {
				env: { ORIGIN: 'https://configured.example.com/ignored-path' },
				label: 'origin-app'
			}));
		}, 30_000);

		afterAll(() => stop_app(server));

		test('ORIGIN determines the request origin, normalised to a bare origin', async () => {
			const res = await fetch(`${base_url}/origin`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('https://configured.example.com');
		});
	});

	describe('with ORIGIN unset', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';

		beforeAll(async () => {
			({ base_url, server } = await start_app(['bun', join(out, 'entry.js')], {
				label: 'no-origin-app'
			}));
		}, 30_000);

		afterAll(() => stop_app(server));

		test('falls back to the request-derived origin, defaulting the protocol to https', async () => {
			// no PROTOCOL_HEADER is configured, so the derived origin defaults to
			// `https` per upstream adapter-node's `get_origin` — even though this
			// server itself is plain http
			const res = await fetch(`${base_url}/origin`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(base_url.replace(/^http:/, 'https:'));
		});
	});
});
