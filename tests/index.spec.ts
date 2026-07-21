import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../src/windows-brand.js', () => ({ apply_windows_branding: vi.fn() }));

import plugin from '../index.js';
import { apply_windows_branding } from '../src/windows-brand.js';

interface BunBuildCall {
	entrypoints: string[];
	compile: { outfile: string; target?: string; windows?: Record<string, unknown> };
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
			write: async (path: string, data: string | ArrayBuffer) => {
				mkdirSync(dirname(path), { recursive: true });
				if (typeof data === 'string') {
					writes.set(path, data);
					writeFileSync(path, data);
				} else {
					writeFileSync(path, Buffer.from(data));
				}
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
				json: async () => JSON.parse(readFileSync(path, 'utf8')),
				arrayBuffer: async () => {
					const buf = readFileSync(path);
					return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				}
			}),
			build: async (opts: BunBuildCall) => {
				build_calls.push(opts);
				if (build_success) {
					// simulate `--compile` writing the executable to disk
					mkdirSync(dirname(opts.compile.outfile), { recursive: true });
					writeFileSync(opts.compile.outfile, Buffer.from('FAKE_COMPILED_EXECUTABLE'));
				}
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

function set_platform(value: string) {
	Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('windows option', () => {
	let original_platform: NodeJS.Platform;

	beforeEach(() => {
		original_platform = process.platform;
		vi.mocked(apply_windows_branding).mockReset();
	});

	afterEach(() => {
		set_platform(original_platform);
	});

	test('post-processes the compiled executable when cross-compiling to bun-windows-* from a non-Windows host', async () => {
		set_platform('darwin');
		vi.mocked(apply_windows_branding).mockReturnValue(new TextEncoder().encode('PATCHED').buffer);

		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin({ targets: ['bun-windows-x64'], windows: { title: 'My App' } });
		await p.adapt(builder as never);

		// compile.windows is NOT passed to Bun.build — Bun would silently ignore it anyway
		expect(mock.build_calls[0].compile.windows).toBeUndefined();

		expect(apply_windows_branding).toHaveBeenCalledTimes(1);
		const [, windows_arg, icon_arg] = vi.mocked(apply_windows_branding).mock.calls[0];
		expect(windows_arg).toEqual({ title: 'My App' });
		expect(icon_arg).toBeNull();

		// the post-processed bytes were written back to the same outfile
		const outfile = join(tmp_cwd, 'build/app-bun-windows-x64');
		expect(readFileSync(outfile, 'utf8')).toBe('PATCHED');

		expect(logs.warn.some((m) => m.includes('post-processing'))).toBe(true);
	});

	test('reads and forwards the icon file when windows.icon is set during cross-compile post-processing', async () => {
		set_platform('darwin');
		vi.mocked(apply_windows_branding).mockReturnValue(new ArrayBuffer(0));

		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);
		writeFileSync(join(tmp_cwd, 'icon.ico'), Buffer.from('FAKE_ICO_BYTES'));

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ targets: ['bun-windows-x64'], windows: { icon: join(tmp_cwd, 'icon.ico') } });
		await p.adapt(builder as never);

		const [, , icon_arg] = vi.mocked(apply_windows_branding).mock.calls[0];
		expect(Buffer.from(icon_arg as ArrayBuffer).toString()).toBe('FAKE_ICO_BYTES');
	});

	test('throws a clear error when windows.icon points to a missing file during cross-compile', async () => {
		set_platform('darwin');
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ targets: ['bun-windows-x64'], windows: { icon: 'does-not-exist.ico' } });
		await expect(p.adapt(builder as never)).rejects.toThrow(/windows\.icon.*file not found/);
		expect(apply_windows_branding).not.toHaveBeenCalled();
	});

	test('warns and skips (does not throw) when windows is set but no Windows target is built', async () => {
		set_platform('darwin');
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin({ targets: ['bun-linux-x64'], windows: { title: 'My App' } });
		await p.adapt(builder as never);

		expect(logs.warn.some((m) => m.includes('no Windows target is being built'))).toBe(true);
		expect(mock.build_calls[0].compile.windows).toBeUndefined();
	});

	test('applies windows options natively for the implicit host build on a Windows host', async () => {
		set_platform('win32');
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, logs } = create_builder_mock(tmp_cwd);
		const p = plugin({
			windows: {
				icon: 'icon.ico',
				hideConsole: true,
				title: 'My App',
				publisher: 'Acme',
				version: '1.2.3.4',
				description: 'An app',
				copyright: '© Acme'
			}
		});
		await p.adapt(builder as never);

		expect(mock.build_calls).toHaveLength(1);
		expect(mock.build_calls[0].compile.windows).toEqual({
			icon: 'icon.ico',
			hideConsole: true,
			title: 'My App',
			publisher: 'Acme',
			version: '1.2.3.4',
			description: 'An app',
			copyright: '© Acme'
		});
		expect(logs.warn).toHaveLength(0);
	});

	test('applies windows options only to the bun-windows-* job among multiple targets on a Windows host', async () => {
		set_platform('win32');
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({
			targets: ['bun-linux-x64', 'bun-windows-x64'],
			windows: { title: 'My App' }
		});
		await p.adapt(builder as never);

		const windows_call = mock.build_calls.find((c) => c.compile.target === 'bun-windows-x64');
		const linux_call = mock.build_calls.find((c) => c.compile.target === 'bun-linux-x64');
		expect(windows_call?.compile.windows).toEqual({ title: 'My App' });
		expect(linux_call?.compile.windows).toBeUndefined();
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
