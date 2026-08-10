import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
	build_fixture,
	start_app,
	stop_app,
	free_port,
	type SpawnedServer
} from '../helpers/fixture.js';

/**
 * Runtime environment semantics, end to end. The `envPrefix` half runs against a
 * compiled single-file executable — a misconfigured environment must abort a shipped
 * binary, not just `bun entry.js`. The idle-timeout half uses `compile: false` builds:
 * the behaviour lives in `serve.js`, which is identical in both modes, and the specs
 * there each need several differently configured app starts.
 */

/** Run a built app to completion, returning its exit code and stderr. */
function run_until_exit(
	command: string[],
	env: Record<string, string>,
	timeout_ms = 15_000
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const [bin, ...args] = command;
		const child = spawn(bin, args, {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stderr = '';
		child.stderr.on('data', (b) => (stderr += b));
		child.stdout.on('data', () => {});

		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`app did not exit within ${timeout_ms}ms; stderr:\n${stderr}`));
		}, timeout_ms);

		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
		child.on('error', reject);
	});
}

describe('envPrefix collision detection (compiled executable)', () => {
	let command: string[] = [];

	beforeAll(async () => {
		command = [join(build_fixture({ out: 'build-env-prefix', env_prefix: 'MY_APP_' }), 'app')];
	}, 240_000);

	test('an unknown prefixed variable aborts startup', async () => {
		const { code, stderr } = await run_until_exit(command, {
			MY_APP_PORT: String(await free_port()),
			MY_APP_BOGUS: '1'
		});

		expect(code).not.toBe(0);
		expect(stderr).toMatch(/You should change envPrefix \(MY_APP_\)/);
		expect(stderr).toContain('MY_APP_BOGUS');
	});

	test('an adapter-node-only prefixed variable aborts startup with an explanation', async () => {
		const { code, stderr } = await run_until_exit(command, {
			MY_APP_PORT: String(await free_port()),
			MY_APP_IDLE_TIMEOUT: '5'
		});

		expect(code).not.toBe(0);
		expect(stderr).toContain('MY_APP_IDLE_TIMEOUT is not supported');
		expect(stderr).toContain('CONNECTION_IDLE_TIMEOUT');
	});

	test.each(['MY_APP_SOCKET_PATH=/tmp/x', 'MY_APP_KEEP_ALIVE_TIMEOUT=5', 'MY_APP_LISTEN_FDS=1'])(
		'%s aborts startup',
		async (pair) => {
			const [name, value] = pair.split('=');
			const { code, stderr } = await run_until_exit(command, {
				MY_APP_PORT: String(await free_port()),
				[name]: value
			});

			expect(code).not.toBe(0);
			expect(stderr).toContain(`${name} is not supported`);
		}
	);

	test('unprefixed variables are left alone, and supported prefixed ones work', async () => {
		let server: SpawnedServer | null = null;
		try {
			// IDLE_TIMEOUT etc. without the prefix may belong to something else in the
			// environment — with an envPrefix configured they must be ignored entirely
			const started = await start_app(command, {
				env_prefix: 'MY_APP_',
				env: {
					IDLE_TIMEOUT: '1',
					SOCKET_PATH: '/tmp/nope',
					MY_APP_CONNECTION_IDLE_TIMEOUT: '30'
				},
				label: 'prefixed'
			});
			server = started.server;
			const res = await fetch(`${started.base_url}/about`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('About (prerendered)');
		} finally {
			await stop_app(server);
		}
	}, 60_000);
});

describe('idle timeout semantics', () => {
	let entry = '';

	beforeAll(() => {
		entry = join(build_fixture({ out: 'build-env', compile: false }), 'entry.js');
	}, 180_000);

	// the accompanying stderr warning is asserted in tests/serve.spec.ts, where the
	// `warn` callback of `validate_env` can be observed directly
	test('adapter-node-only variables are ignored (not repurposed) without a prefix', async () => {
		let server: SpawnedServer | null = null;
		try {
			const started = await start_app(['bun', entry], {
				env: { IDLE_TIMEOUT: '1' },
				label: 'warn'
			});
			server = started.server;

			// a quiet request outlives IDLE_TIMEOUT=1, i.e. the variable really is ignored
			const res = await fetch(`${started.base_url}/slow?delay=3000`);
			expect(res.status).toBe(200);
		} finally {
			await stop_app(server);
		}
	}, 60_000);

	describe('with the default configuration', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';

		beforeAll(async () => {
			({ base_url, server } = await start_app(['bun', entry], {
				label: 'default-idle'
			}));
		}, 60_000);
		afterAll(() => stop_app(server));

		test('a response that stays quiet for longer than Bun’s 10s default is not cut off', async () => {
			const res = await fetch(`${base_url}/slow?delay=12000`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('slept 12000ms');
		}, 40_000);

		test('an SSE stream with quiet gaps completes', async () => {
			const res = await fetch(`${base_url}/stream?gap=1500&ticks=2`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('data: tick 1');
		}, 30_000);
	});

	describe('with CONNECTION_IDLE_TIMEOUT=2', () => {
		let server: SpawnedServer | null = null;
		let base_url = '';

		beforeAll(async () => {
			({ base_url, server } = await start_app(['bun', entry], {
				env: { CONNECTION_IDLE_TIMEOUT: '2' },
				label: 'idle-2'
			}));
		}, 60_000);
		afterAll(() => stop_app(server));

		test('a fast response is unaffected', async () => {
			const res = await fetch(`${base_url}/slow?delay=200`);
			expect(res.status).toBe(200);
		});

		test('a quiet non-streaming request is closed once configured', async () => {
			await expect(fetch(`${base_url}/slow?delay=8000`)).rejects.toThrow();
		}, 30_000);

		test('an SSE stream is exempted from the configured timeout', async () => {
			const res = await fetch(`${base_url}/stream?gap=4000&ticks=2`);
			expect(res.status).toBe(200);
			expect(res.headers.get('x-accel-buffering')).toBe('no');
			expect(await res.text()).toContain('data: tick 1');
		}, 30_000);
	});

	test.each([
		['abc', /must be a non-negative integer/],
		['-1', /must be a non-negative integer/],
		['1.5', /must be a non-negative integer/],
		['300', /must be at most 255 seconds/]
	])('CONNECTION_IDLE_TIMEOUT=%s aborts startup', async (value, pattern) => {
		const { code, stderr } = await run_until_exit(['bun', entry], {
			PORT: String(await free_port()),
			CONNECTION_IDLE_TIMEOUT: value
		});

		expect(code).not.toBe(0);
		expect(stderr).toMatch(pattern);
	});
});
