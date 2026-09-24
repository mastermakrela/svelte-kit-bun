import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';

// mirrors kit's own `builder.compress`: only these extensions get gzip/brotli siblings
const COMPRESSIBLE_EXTENSIONS = [
	'.html',
	'.js',
	'.mjs',
	'.json',
	'.css',
	'.svg',
	'.xml',
	'.wasm',
	'.txt',
	'.md',
	'.mdx'
];

/**
 * Mirrors `builder.compress`: writes a `.gz` and a `.br` sibling for every
 * compressible file under `dir` and returns their paths relative to `dir`.
 */
function compress_dir(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const compressed: string[] = [];

	function walk(current: string, rel: string) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const abs = join(current, entry.name);
			const entry_rel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(abs, entry_rel);
			} else if (COMPRESSIBLE_EXTENSIONS.includes(extname(entry.name))) {
				const contents = readFileSync(abs);
				writeFileSync(`${abs}.gz`, Buffer.concat([Buffer.from('GZ:'), contents]));
				writeFileSync(`${abs}.br`, Buffer.concat([Buffer.from('BR:'), contents]));
				compressed.push(entry_rel);
			}
		}
	}

	walk(dir, '');
	return compressed;
}

vi.mock('../src/windows-brand.js', () => ({ apply_windows_branding: vi.fn() }));

import plugin from '../index.js';
import { apply_windows_branding } from '../src/windows-brand.js';

interface BunBuildCall {
	entrypoints: string[];
	compile: { outfile: string; target?: string; windows?: Record<string, unknown> };
	target: string;
	/** contents of `entrypoints[0]` at the time the build was requested */
	entry_source?: string;
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
				build_calls.push({
					...opts,
					entry_source: readFileSync(opts.entrypoints[0], 'utf8')
				});
				// Mirror real Bun.build: for a `bun-windows-*` target, an `outfile`
				// with no extension gets `.exe` appended automatically.
				let compiled_path = opts.compile.outfile;
				if (opts.compile.target?.startsWith('bun-windows') && !/\.[^/\\]+$/.test(compiled_path)) {
					compiled_path += '.exe';
				}
				if (build_success) {
					// simulate `--compile` writing the executable to disk
					mkdirSync(dirname(compiled_path), { recursive: true });
					writeFileSync(compiled_path, Buffer.from('FAKE_COMPILED_EXECUTABLE'));
				}
				return {
					success: build_success,
					logs: build_success ? [] : [{ message: 'mock build failure' }],
					outputs: build_success ? [{ path: compiled_path, kind: 'entry-point' }] : []
				};
			}
		},
		cwd
	};
}

interface InstrumentCall {
	entrypoint: string;
	instrumentation: string;
	initializer: string;
	start?: string;
	module?: { exports: string[] };
}

interface BuilderMock {
	builder: {
		config: { paths: { base: string; origin?: string }; appDir: string };
		log: {
			minor: (msg: string) => void;
			warn: (msg: string) => void;
			error: (msg: string) => void;
		};
		getBuildDirectory: (name: string) => string;
		writeClient: (dir: string) => string[];
		writePrerendered: (dir: string) => string[];
		writeServer: (dir: string) => string[];
		compress: (dir: string) => Promise<string[]>;
		copy: (from: string, to: string) => void;
		generateServerInstance: (dest: string, opts?: { serverDirectory?: string }) => void;
		getAppPath: () => string;
		mimeTypes: Record<string, string>;
		createInstrumentationInitializer: (opts: {
			outputDirectory: string;
			serverDirectory?: string;
		}) => string;
		findServerAssets: (routes: unknown[]) => string[];
		hasServerInstrumentationFile: () => boolean;
		instrument: (args: InstrumentCall) => void;
		prerendered: {
			paths: string[];
			pages: Map<string, { file: string }>;
			assets: Map<string, unknown>;
		};
		routes: unknown[];
	};
	logs: { minor: string[]; warn: string[]; error: string[] };
	copies: Array<{ from: string; to: string }>;
	instrument_calls: InstrumentCall[];
	server_instances: Array<{ dest: string; serverDirectory?: string }>;
}

function create_builder_mock(
	cwd: string,
	{ instrumentation = false }: { instrumentation?: boolean } = {}
): BuilderMock {
	const logs = { minor: [] as string[], warn: [] as string[], error: [] as string[] };
	const copies: Array<{ from: string; to: string }> = [];
	const instrument_calls: InstrumentCall[] = [];
	const server_instances: Array<{ dest: string; serverDirectory?: string }> = [];

	return {
		logs,
		copies,
		instrument_calls,
		server_instances,
		builder: {
			config: { paths: { base: '' }, appDir: '_app' },
			log: {
				minor: (msg: string) => logs.minor.push(msg),
				warn: (msg: string) => logs.warn.push(msg),
				error: (msg: string) => logs.error.push(msg)
			},
			getBuildDirectory: (name: string) => join(cwd, '.svelte-kit', name),
			// `measure()` reads these files from disk to compute size/etag, so the mock has
			// to actually write them, not just report their names.
			writeClient: (dir: string) => {
				mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
				writeFileSync(join(dir, 'favicon.png'), 'FAKE_PNG_BYTES');
				writeFileSync(join(dir, '_app/immutable/chunks/abc.js'), 'console.log("abc");\n');
				return ['favicon.png', '_app/immutable/chunks/abc.js'];
			},
			writePrerendered: (dir: string) => {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, 'about.html'), '<h1>About</h1>\n');
				return ['about.html'];
			},
			compress: async (dir: string) => compress_dir(dir),
			// kit emits `instrumentation.server.js` into the server output, so it lands in
			// the adapter's output directory as part of `writeServer`
			writeServer: (dir: string) => {
				if (instrumentation) {
					mkdirSync(dir, { recursive: true });
					writeFileSync(`${dir}/instrumentation.server.js`, '// instrumentation\n');
				}
				return [];
			},
			copy: (from: string, to: string) => {
				copies.push({ from, to });
			},
			generateServerInstance: (dest, { serverDirectory } = {}) => {
				server_instances.push({ dest, serverDirectory });
				mkdirSync(dirname(dest), { recursive: true });
				writeFileSync(dest, 'export const server = {};\n');
			},
			getAppPath: () => '_app',
			mimeTypes: { '.png': 'image/png' },
			// mirrors `create_builder`: writes the initializer into `outputDirectory`
			createInstrumentationInitializer: ({ outputDirectory }) => {
				const initializer = join(outputDirectory, '__sveltekit_env_init.js');
				mkdirSync(outputDirectory, { recursive: true });
				writeFileSync(initializer, '// env initializer\n');
				return initializer;
			},
			findServerAssets: () => ['data.bin'],
			hasServerInstrumentationFile: () => instrumentation,
			// mirrors `create_builder`'s implementation: move the entrypoint aside and
			// replace it with a facade that imports the instrumentation module first
			instrument: (args: InstrumentCall) => {
				instrument_calls.push(args);
				// kit refuses to instrument if any of the files is missing
				for (const file of [args.entrypoint, args.instrumentation, args.initializer]) {
					if (!existsSync(file)) throw new Error(`${file} not found`);
				}
				const start = args.start ?? join(dirname(args.entrypoint), 'start.js');
				writeFileSync(start, readFileSync(args.entrypoint, 'utf8'));
				writeFileSync(
					args.entrypoint,
					`import './${relative(dirname(args.entrypoint), args.initializer)}';\n` +
						`import './${relative(dirname(args.entrypoint), args.instrumentation)}';\n` +
						`const __mod = await import('./${relative(dirname(args.entrypoint), start)}');\n`
				);
			},
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
	vi.unstubAllEnvs();
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

	// without this, kit refuses to build an app that has `src/instrumentation.server.js`
	test('supports.instrumentation returns true', () => {
		const p = plugin();
		expect(p.supports?.instrumentation?.()).toBe(true);
	});
});

describe('server instrumentation', () => {
	test('does not instrument the entry when the app has no instrumentation file', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, instrument_calls } = create_builder_mock(tmp_cwd);
		await plugin().adapt(builder as never);

		expect(instrument_calls).toHaveLength(0);
		expect(mock.build_calls[0].entry_source).toContain('await start({');
	});

	test('instruments the generated entry with the emitted instrumentation module', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, instrument_calls } = create_builder_mock(tmp_cwd, { instrumentation: true });
		await plugin({ out: 'build' }).adapt(builder as never);

		expect(instrument_calls).toEqual([
			{
				entrypoint: 'build/entry.js',
				instrumentation: 'build/server/instrumentation.server.js',
				initializer: 'build/server/__sveltekit_env_init.js',
				module: { exports: [] }
			}
		]);
	});

	test('compiles the instrumented facade, not the original entry', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd, { instrumentation: true });
		await plugin({ out: 'build' }).adapt(builder as never);

		// the entry Bun compiles must load instrumentation before the app, so it has to
		// be the facade written by `builder.instrument` — i.e. instrumenting happens
		// before `Bun.build`, and the real entry moved to `start.js`
		const entry_source = mock.build_calls[0].entry_source!;
		expect(mock.build_calls[0].entrypoints).toEqual(['build/entry.js']);
		expect(entry_source).toContain("import './server/__sveltekit_env_init.js';");
		expect(entry_source).toContain("import './server/instrumentation.server.js';");
		expect(entry_source.indexOf('__sveltekit_env_init')).toBeLessThan(
			entry_source.indexOf('instrumentation.server')
		);
		expect(entry_source).toContain("await import('./start.js')");
		expect(entry_source).not.toContain('await start({');
		expect(readFileSync(join(tmp_cwd, 'build/start.js'), 'utf8')).toContain('await start({');
	});

	test('instruments the entry even when compile is disabled', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder, instrument_calls } = create_builder_mock(tmp_cwd, { instrumentation: true });
		await plugin({ compile: false }).adapt(builder as never);

		expect(instrument_calls).toHaveLength(1);
		expect(readFileSync(join(tmp_cwd, 'build/entry.js'), 'utf8')).toContain(
			"import './server/instrumentation.server.js';"
		);
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

		const { builder, copies, server_instances } = create_builder_mock(tmp_cwd);
		const p = plugin({ out: 'build' });
		await p.adapt(builder as never);

		expect(mock.writes.has('build/entry.js')).toBe(true);
		expect(server_instances).toEqual([
			{ dest: 'build/server/server.js', serverDirectory: 'build/server' }
		]);

		const manifest = mock.writes.get('build/server/manifest.js')!;
		expect(manifest).toContain('export const prerendered = new Set(["/about"]);');
		expect(manifest).toContain('export const app_path = "_app";');
		expect(manifest).toContain('export const mime_types = {".png":"image/png"};');

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('import { server } from "./server/server.js"');
		expect(entry).toContain('import { start } from "./serve.js"');
		expect(entry).toContain('import _client_0 from "./client/favicon.png"');
		expect(entry).toContain('"/about": { file: _prerendered_0');
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

		// the post-processed bytes were written back to the actual compiled path —
		// which Bun names with a `.exe` suffix it appends itself, not the bare
		// `outfile` the adapter asked for.
		const outfile = join(tmp_cwd, 'build/app-bun-windows-x64.exe');
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
		const p = plugin({
			targets: ['bun-windows-x64'],
			windows: { icon: join(tmp_cwd, 'icon.ico') }
		});
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

describe('precompression', () => {
	test('embeds br/gz variants and their sizes for compressible assets by default', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		// _app/immutable/chunks/abc.js is .js — compressible
		expect(entry).toContain(".br\" with { type: 'file' }");
		expect(entry).toContain(".gz\" with { type: 'file' }");
		expect(entry).toMatch(/br: \{ file: _client_1_br, size: \d+ \}/);
		expect(entry).toMatch(/gz: \{ file: _client_1_gz, size: \d+ \}/);
		// about.html is .html — compressible too
		expect(entry).toMatch(/br: \{ file: _prerendered_0_br, size: \d+ \}/);
	});

	test('favicon.png has no extension eligible for compression, so it gets no variants', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('"/favicon.png": { file: _client_0, size:');
		expect(entry).not.toContain('_client_0_br');
		expect(entry).not.toContain('_client_0_gz');
	});

	test('precompress: false never calls builder.compress and embeds no variants', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const compress_spy = vi.spyOn(builder, 'compress');
		const p = plugin({ compile: false, precompress: false });
		await p.adapt(builder as never);

		expect(compress_spy).not.toHaveBeenCalled();
		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).not.toContain('.br"');
		expect(entry).not.toContain('.gz"');
	});

	test('a dotfile among builder.prerendered.assets is not embedded', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		// `is_hidden` runs before the file is even touched on disk, so no file needs
		// to actually exist at this path for the filtering behaviour to be observed.
		builder.prerendered.assets = new Map([['/.env', {}]]);

		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).not.toContain('.env');
		expect(entry).not.toContain('/prerendered/.env');
	});
});

describe('base path handling', () => {
	test('prefixes client/prerendered asset paths with base', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		builder.config.paths.base = '/my-app';

		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('import _client_0 from "./client/my-app/favicon.png"');
		expect(entry).toContain('"/my-app/favicon.png": { file: _client_0');
	});
});

describe('paths.origin handling', () => {
	test('bakes a configured origin into the generated entry', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		builder.config.paths.origin = 'https://example.com';

		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).toContain('origin: "https://example.com"');
	});

	test('omits origin from the generated entry when unset', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).not.toContain('origin:');
	});

	test('an ORIGIN environment variable at build time has no effect', async () => {
		const mock = create_bun_mock(tmp_cwd);
		vi.stubGlobal('Bun', mock.Bun);
		vi.stubEnv('ORIGIN', 'https://from-env.example.com');

		const { builder } = create_builder_mock(tmp_cwd);
		const p = plugin({ compile: false });
		await p.adapt(builder as never);

		const entry = mock.writes.get('build/entry.js')!;
		expect(entry).not.toContain('from-env.example.com');
	});
});
