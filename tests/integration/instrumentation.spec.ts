import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build_fixture, start_app, stop_app, type SpawnedServer } from '../helpers/fixture.js';

/**
 * The fixture's `instrumentation.server.js` and `hooks.server.js` both append to
 * `globalThis.__adapter_bun_load_order`, and `/instrumentation` reports it. Hooks are
 * loaded by `server.init()` at startup, so the recorded order says whether the
 * instrumentation module really ran before the application code.
 */
const MARKER = 'INSTRUMENTATION_MARKER_9f3a71';
const RUNTIME_SECRET = 'runtime-secret-4c1e';

describe('server instrumentation (compiled executable)', () => {
	let server: SpawnedServer | null = null;
	let base_url = '';
	let out = '';

	beforeAll(async () => {
		out = build_fixture({ out: 'build-instrumented', instrumentation: true });
		({ base_url, server } = await start_app([join(out, 'app')], {
			label: 'instrumented-app',
			env: { FIXTURE_RUNTIME_SECRET: RUNTIME_SECRET }
		}));
	}, 240_000);

	afterAll(() => stop_app(server));

	test('the generated entry is a facade that imports instrumentation first', () => {
		const entry = readFileSync(join(out, 'entry.js'), 'utf8');
		const instrumentation = entry.search(/import ['"]\.\/server\/instrumentation\.server\.js['"];/);
		expect(instrumentation).toBeGreaterThan(-1);
		expect(entry.search(/await import\(['"]\.\/start\.js['"]\)/)).toBeGreaterThan(instrumentation);
		// the actual server bootstrap moved to start.js, so it is imported *after*
		expect(entry).not.toContain('await start({');
		expect(readFileSync(join(out, 'start.js'), 'utf8')).toContain('await start({');
	});

	test('instrumentation ran before application code', async () => {
		const res = await fetch(`${base_url}/instrumentation`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			order: ['instrumentation', 'app'],
			marker: MARKER,
			// `$app/env/private` was already populated from the runtime environment
			env: RUNTIME_SECRET
		});
	});

	test('the compiled executable embeds the instrumentation module', () => {
		const binary = readFileSync(join(out, 'app'));
		// Bun stores the bundled source as UTF-16 when it contains any non-Latin-1
		// character (which the SvelteKit 2 server output does), as Latin-1 otherwise
		const embedded =
			binary.includes(Buffer.from(MARKER, 'latin1')) ||
			binary.includes(Buffer.from(MARKER, 'utf16le'));
		expect(embedded).toBe(true);
	});

	test('the app still serves requests normally', async () => {
		const res = await fetch(`${base_url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
	});
});
