import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';

export const repo_root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixture = join(repo_root, 'tests/fixtures/basic-app');

/**
 * `bun install` materializes the `file:../../..` dependency as hardlinks, which
 * break as soon as an adapter source file is rewritten — the fixture would then
 * build against a stale copy of the adapter and tests would pass or fail for the
 * wrong reasons. Fail loudly instead.
 */
function assert_adapter_is_current() {
	const linked = join(fixture, 'node_modules/svelte-kit-bun');

	for (const file of ['index.js', 'src/codegen.js', 'files/serve.js']) {
		if (readFileSync(join(linked, file), 'utf8') !== readFileSync(join(repo_root, file), 'utf8')) {
			throw new Error(
				`${file} in the fixture's node_modules is stale (bun install hardlinks it, and editing ` +
					'the file breaks the link). Re-run `rm -rf node_modules/.bun/svelte-kit-bun@root && bun install`.'
			);
		}
	}
}

export interface BuildOptions {
	/** Adapter `out` directory, relative to the fixture root. @default 'build' */
	out?: string;
	/** Value for `kit.paths.origin`. Left unset when omitted. */
	origin?: string;
	/** Value for `kit.paths.base`. @default '' */
	base?: string;
	/** Adapter `compile` option. @default true */
	compile?: boolean;
	/** Adapter `envPrefix` option. @default '' */
	env_prefix?: string;
	/**
	 * Build with `src/instrumentation.server.js` in place (copied from the fixture
	 * root, where SvelteKit does not look for it). @default false
	 */
	instrumentation?: boolean;
}

/** Where SvelteKit looks for the server instrumentation module. */
const instrumentation_target = join(fixture, 'src/instrumentation.server.js');

/** Build the fixture app with `vite build` and return the absolute output directory. */
export function build_fixture({
	out = 'build',
	origin,
	base = '',
	compile = true,
	env_prefix = '',
	instrumentation = false
}: BuildOptions = {}): string {
	assert_adapter_is_current();

	rmSync(join(fixture, out), { recursive: true, force: true });
	rmSync(join(fixture, '.svelte-kit'), { recursive: true, force: true });

	// the file is only present for instrumented builds, so the same fixture covers both
	rmSync(instrumentation_target, { force: true });
	if (instrumentation) {
		copyFileSync(join(fixture, 'instrumentation.server.js'), instrumentation_target);
	}

	let build;
	try {
		build = spawnSync('bun', ['run', 'build'], {
			cwd: fixture,
			stdio: 'inherit',
			env: {
				...process.env,
				ADAPTER_BUN_OUT: out,
				ADAPTER_BUN_COMPILE: String(compile),
				ADAPTER_BUN_ENV_PREFIX: env_prefix,
				ADAPTER_BUN_BASE: base,
				...(origin ? { ADAPTER_BUN_ORIGIN: origin } : {})
			}
		});
	} finally {
		rmSync(instrumentation_target, { force: true });
	}
	if (build.status !== 0) {
		throw new Error(`bun run build failed (status ${build.status})`);
	}

	const dir = join(fixture, out);
	if (!existsSync(join(dir, 'entry.js'))) {
		throw new Error(`expected generated entry at ${join(dir, 'entry.js')}`);
	}
	return dir;
}

/** Find a free TCP port by opening an ephemeral listener and reading its address. */
export function free_port(): Promise<number> {
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

export async function wait_for_http(url: string, timeout_ms: number) {
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

export type SpawnedServer = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Spawn a built app (either the compiled binary or `bun <out>/entry.js`) on a free
 * port and wait until it answers, returning its base URL and the child process.
 */
export async function start_app(
	command: string[],
	{
		env = {},
		label = 'app',
		env_prefix = ''
	}: {
		env?: Record<string, string>;
		label?: string;
		/** Prefix the app was built with, applied to the HOST/PORT this helper sets. */
		env_prefix?: string;
	} = {}
): Promise<{ base_url: string; server: SpawnedServer }> {
	const port = await free_port();
	const [bin, ...args] = command;

	const server = spawn(bin, args, {
		env: {
			...process.env,
			[`${env_prefix}HOST`]: '127.0.0.1',
			[`${env_prefix}PORT`]: String(port),
			...env
		},
		stdio: ['ignore', 'pipe', 'pipe']
	}) as SpawnedServer;
	server.stdout.on('data', (b) => process.stdout.write(`[${label} stdout] ${b}`));
	server.stderr.on('data', (b) => process.stderr.write(`[${label} stderr] ${b}`));

	const base_url = `http://127.0.0.1:${port}`;
	await wait_for_http(`${base_url}/about`, 15_000);

	return { base_url, server };
}

export async function stop_app(server: SpawnedServer | null) {
	if (!server) return;
	server.kill('SIGTERM');
	await new Promise((r) => setTimeout(r, 100));
	if (server.exitCode === null) server.kill('SIGKILL');
}
