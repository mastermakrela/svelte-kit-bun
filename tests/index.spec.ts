import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import plugin from '../index.js';

interface BunBuildCall {
	entrypoints: string[];
	compile: { outfile: string; target?: string };
	target: string;
}

function create_bun_mock(cwd: string, options: { build_success?: boolean } = {}) {
	const { build_success = true } = options;
	const writes = new Map<string, string>();
	const build_calls: BunBuildCall[] = [];

	return {
		writes,
		build_calls,
		Bun: {
			write: async (path: string, data: string) => {
				writes.set(path, data);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, data);
			},
			file: (path: string) => ({
				exists: async () => {
					try {
						readFileSync(path);
						return true;
					} catch {
						return false;
					}
				},
				json: async () => JSON.parse(readFileSync(path, 'utf8'))
			}),
			build: async (opts: BunBuildCall) => {
				build_calls.push(opts);
				return {
					success: build_success,
					logs: build_success ? [] : [{ message: 'mock build failure' }]
				};
			}
		},
		cwd
	};
}

interface BuilderMock {
	builder: {
		config: { kit: { paths: { base: string }; appDir: string } };
		log: {
			minor: (msg: string) => void;
			warn: (msg: string) => void;
			error: (msg: string) => void;
		};
		getBuildDirectory: (name: string) => string;
		rimraf: (dir: string) => void;
		mkdirp: (dir: string) => void;
		writeClient: (dir: string) => string[];
		writePrerendered: (dir: string) => string[];
		writeServer: (dir: string) => string[];
		copy: (from: string, to: string) => void;
		generateManifest: (opts: { relativePath: string }) => string;
		findServerAssets: (routes: unknown[]) => string[];
		prerendered: {
			paths: string[];
			pages: Map<string, { file: string }>;
			assets: Map<string, unknown>;
		};
		routes: unknown[];
	};
	logs: { minor: string[]; warn: string[]; error: string[] };
	copies: Array<{ from: string; to: string }>;
}

function create_builder_mock(cwd: string): BuilderMock {
	const logs = { minor: [] as string[], warn: [] as string[], error: [] as string[] };
	const copies: Array<{ from: string; to: string }> = [];

	return {
		logs,
		copies,
		builder: {
			config: { kit: { paths: { base: '' }, appDir: '_app' } },
			log: {
				minor: (msg: string) => logs.minor.push(msg),
				warn: (msg: string) => logs.warn.push(msg),
				error: (msg: string) => logs.error.push(msg)
			},
			getBuildDirectory: (name: string) => join(cwd, '.svelte-kit', name),
			rimraf: (dir: string) => {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			},
			mkdirp: () => {},
			writeClient: () => ['favicon.png', '_app/immutable/chunks/abc.js'],
			writePrerendered: () => [],
			writeServer: () => [],
			copy: (from: string, to: string) => {
				copies.push({ from, to });
			},
			generateManifest: ({ relativePath }) => `{relative:${JSON.stringify(relativePath)}}`,
			findServerAssets: () => ['data.bin'],
			prerendered: {
				paths: ['/about'],
				pages: new Map([['/about', { file: 'about.html' }]]),
				assets: new Map()
			},
			routes: []
		}
	};
}

let tmp_cwd: string;
let original_cwd: string;

beforeEach(() => {
	tmp_cwd = mkdtempSync(join(tmpdir(), 'adapter-bun-test-'));
	original_cwd = process.cwd();
	process.chdir(tmp_cwd);
});

afterEach(() => {
	process.chdir(original_cwd);
	try {
		rmSync(tmp_cwd, { recursive: true, force: true });
	} catch {
		// ignore
	}
	vi.unstubAllGlobals();
});

describe('plugin metadata', () => {
	test('exposes name', () => {
		const p = plugin();
		expect(p.name).toBe('@sveltejs/adapter-bun');
	});

	test('supports.read returns true', () => {
		const p = plugin();
		expect(p.supports?.read?.({ config: {}, route: { id: '/x' } } as never)).toBe(true);
	});
});

describe('adapt hook', () => {
	test('throws when globalThis.Bun is undefined', async () => {
		vi.stubGlobal('Bun', undefined);
		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await expect(p.adapt(builder as never)).rejects.toThrow(/Bun runtime not detected/);
	});

	test('writes entry.js and copies files/ when compile=true (happy path)', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, copies } = create_builder_mock(tmp_cwd);
		const p = plugin({ out: 'build' });
		await p.adapt(builder as never);

		expect(mock.writes.has('build/entry.js')).toBe(true);
		expect(mock.writes.has('build/server/manifest.js')).toBe(true);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('import { Server } from "./server/index.js"');
		expect(entry).toContain('import { start } from "./serve.js"');
		expect(entry).toContain('import _client_0 from "./client/favicon.png"');
		expect(entry).toContain('"/about": _prerendered_0');
		expect(entry).toContain('"data.bin": _server_0');
		// server asset name is already relative to the server output dir; no extra prefix
		expect(entry).toContain('import _server_0 from "./server/data.bin"');

		expect(copies.length).toBe(1);
		expect(copies[0].to).toBe('build');

		expect(mock.build_calls).toHaveLength(1);
		expect(mock.build_calls[0].compile.outfile).toBe('build/app');
		expect(mock.build_calls[0].compile.target).toBeUndefined();
	});

	test('compile=false skips Bun.build and leaves entry.js in place', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		expect(mock.writes.has('build/entry.js')).toBe(true);
		expect(mock.build_calls).toHaveLength(0);
		expect(logs.minor.some((m) => m.includes('Skipping executable compile'))).toBe(true);
	});

	test('targets produces one binary per target', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({
			out: 'build',
			binaryName: 'app',
			targets: ['bun-linux-x64', 'bun-darwin-arm64']
		});
		await p.adapt(builder as never);

		expect(mock.build_calls).toHaveLength(2);
		const outfiles = mock.build_calls.map((c) => c.compile.outfile).sort();
		expect(outfiles).toEqual(['build/app-bun-darwin-arm64', 'build/app-bun-linux-x64']);
		const targets = mock.build_calls.map((c) => c.compile.target).sort();
		expect(targets).toEqual(['bun-darwin-arm64', 'bun-linux-x64']);
	});

	test('custom binaryName is used', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ binaryName: 'my-app' });
		await p.adapt(builder as never);

		expect(mock.build_calls[0].compile.outfile).toBe('build/my-app');
	});

	test('envPrefix is threaded into generated entry.js', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ envPrefix: 'MY_APP_', compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('env_prefix: "MY_APP_"');
	});

	test('throws when Bun.build fails', async () => {
		const mock = create_bun_mock(tmp_cwd, { build_success: false });
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await expect(p.adapt(builder as never)).rejects.toThrow(/Bun.build --compile failed/);
		expect(logs.error.some((m) => m.includes('mock build failure'))).toBe(true);
	});

	test('warns on N-API native addons in dependencies', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		writeFileSync(
			join(tmp_cwd, 'package.json'),
			JSON.stringify({ dependencies: { sharp: '^0.33.0', lodash: '^4.0.0' } })
		);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await p.adapt(builder as never);

		expect(logs.warn.some((m) => m.includes('sharp'))).toBe(true);
	});

	test('warns on N-API native addons in devDependencies', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		writeFileSync(
			join(tmp_cwd, 'package.json'),
			JSON.stringify({ devDependencies: { 'better-sqlite3': '^11.0.0' } })
		);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await p.adapt(builder as never);

		expect(logs.warn.some((m) => m.includes('better-sqlite3'))).toBe(true);
	});

	test('does not warn when no native addons are present', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		writeFileSync(
			join(tmp_cwd, 'package.json'),
			JSON.stringify({ dependencies: { svelte: '^5.0.0' } })
		);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await p.adapt(builder as never);

		expect(logs.warn).toHaveLength(0);
	});

	test('handles malformed package.json gracefully with a warning', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		writeFileSync(join(tmp_cwd, 'package.json'), '{ not json');

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin();
		await p.adapt(builder as never);

		expect(logs.warn.some((m) => m.includes('could not parse package.json'))).toBe(true);
	});

	test('skips native-addon check when compile=false', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		writeFileSync(
			join(tmp_cwd, 'package.json'),
			JSON.stringify({ dependencies: { sharp: '^0.33.0' } })
		);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		// native addons work fine when not compiling to a single-file binary
		expect(logs.warn).toHaveLength(0);
	});
});

describe('base path handling', () => {
	test('prefixes client/prerendered asset paths with base', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		builder.config.kit.paths.base = '/my-app';

		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('import _client_0 from "./client/my-app/favicon.png"');
		expect(entry).toContain('"/my-app/favicon.png": _client_0');
	});
});
