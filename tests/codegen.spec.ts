import { describe, expect, test } from 'vitest';
import { generate_entry } from '../src/codegen.js';

const defaults = {
	server_path: './server/server.js',
	manifest_path: './server/manifest.js',
	serve_path: './serve.js'
};

describe('generate_entry', () => {
	test('happy path: snapshot', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{
					import_path: './client/favicon.png',
					key: '/favicon.png',
					size: 1234,
					etag: 'etag-favicon'
				},
				{
					import_path: './client/_app/immutable/chunks/abc.js',
					key: '/_app/immutable/chunks/abc.js',
					size: 42,
					etag: 'etag-abc'
				}
			],
			prerendered_assets: [
				{ import_path: './prerendered/about.html', key: '/about', size: 99, etag: 'etag-about' }
			],
			server_assets: [{ import_path: './server/_app/immutable/assets/data.bin', key: 'data.bin' }]
		});

		expect(output).toMatchSnapshot();
	});

	test('client/prerendered map entries carry build-time size/etag; server assets stay plain identifiers', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [{ import_path: './client/a.png', key: '/a.png', size: 10, etag: 'etag-a' }],
			prerendered_assets: [
				{ import_path: './prerendered/about.html', key: '/about', size: 20, etag: 'etag-about' }
			],
			server_assets: [{ import_path: './server/x.bin', key: 'x.bin' }]
		});

		expect(output).toContain(
			'const client_assets = {\n\t"/a.png": { file: _client_0, size: 10, etag: "etag-a" }\n};'
		);
		expect(output).toContain(
			'const prerendered_assets = {\n\t"/about": { file: _prerendered_0, size: 20, etag: "etag-about" }\n};'
		);
		expect(output).toContain('const server_assets = {\n\t"x.bin": _server_0\n};');
	});

	test('empty asset arrays produce empty object literals', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('const client_assets = {};');
		expect(output).toContain('const prerendered_assets = {};');
		expect(output).toContain('const server_assets = {};');

		// no dangling/trailing commas
		expect(output).not.toMatch(/,\s*\}/);
		expect(output).not.toMatch(/,\s*\)/);

		// no stray asset-import lines were emitted
		expect(output).not.toContain("with { type: 'file' }");

		expect(output).toContain('import { server } from "./server/server.js";');
		expect(output).toContain(
			'import { prerendered, app_path, mime_types } from "./server/manifest.js";'
		);
		expect(output).toContain('import { start } from "./serve.js";');
		expect(output).toContain('await start({');

		// no triple-newline gaps
		expect(output).not.toMatch(/\n\n\n/);
	});

	test('only one category populated: client only', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [{ import_path: './client/a.js', key: '/a.js', size: 10, etag: 'etag-a' }],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('import _client_0 from "./client/a.js" with { type: \'file\' };');
		expect(output).toContain(
			'const client_assets = {\n\t"/a.js": { file: _client_0, size: 10, etag: "etag-a" }\n};'
		);
		expect(output).toContain('const prerendered_assets = {};');
		expect(output).toContain('const server_assets = {};');
		expect(output).not.toMatch(/,\s*\}/);
	});

	test('env_prefix is emitted only when non-empty', () => {
		const without = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: []
		});
		expect(without).not.toContain('env_prefix');

		const with_prefix = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: [],
			env_prefix: 'MY_APP_'
		});
		expect(with_prefix).toContain('\tserver_assets,\n\tenv_prefix: "MY_APP_"');
		expect(with_prefix).not.toMatch(/,\s*\}/);
	});

	test('origin is emitted only when defined', () => {
		const without = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: []
		});
		expect(without).not.toContain('origin');

		const with_origin = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: [],
			origin: 'https://example.com'
		});
		expect(with_origin).toContain('\tserver_assets,\n\torigin: "https://example.com"');
		expect(with_origin).not.toMatch(/,\s*\}/);
	});

	test('origin and env_prefix are emitted together in a stable order', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [],
			prerendered_assets: [],
			server_assets: [],
			origin: 'https://example.com',
			env_prefix: 'MY_APP_'
		});

		expect(output).toContain(
			'\tserver_assets,\n\torigin: "https://example.com",\n\tenv_prefix: "MY_APP_"'
		);
		expect(output).not.toMatch(/,\s*\}/);
	});

	test('special characters in keys and import paths survive JSON.stringify', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{
					import_path: './client/with space.png',
					key: '/with space.png',
					size: 1,
					etag: 'e1'
				},
				{ import_path: './client/quote".js', key: '/quote".js', size: 2, etag: 'e2' },
				{
					import_path: './client/emoji-\u{1F525}.txt',
					key: '/emoji-\u{1F525}.txt',
					size: 3,
					etag: 'e3'
				},
				{
					import_path: './client/slash/nested/file.js',
					key: '/slash/nested/file.js',
					size: 4,
					etag: 'e4'
				}
			],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('"./client/with space.png"');
		expect(output).toContain('"/with space.png"');
		expect(output).toContain('"./client/quote\\".js"');
		expect(output).toContain('"/quote\\".js"');
		expect(output).toContain('"./client/emoji-\u{1F525}.txt"');
		expect(output).toContain('"/emoji-\u{1F525}.txt"');
		expect(output).toContain('"./client/slash/nested/file.js"');
		expect(output).toContain('"/slash/nested/file.js"');

		// Escaped quotes shouldn't unbalance the string literals
		const unescaped_quotes = output.replace(/\\"/g, '').match(/"/g)?.length ?? 0;
		expect(unescaped_quotes % 2).toBe(0);
	});

	test('deterministic: same input produces byte-identical output', () => {
		const input = {
			...defaults,
			client_assets: [
				{ import_path: './client/a.png', key: '/a.png', size: 1, etag: 'ea' },
				{ import_path: './client/b.png', key: '/b.png', size: 2, etag: 'eb' }
			],
			prerendered_assets: [
				{ import_path: './prerendered/index.html', key: '/', size: 3, etag: 'ei' }
			],
			server_assets: [{ import_path: './server/x.bin', key: 'x.bin' }]
		};

		const a = generate_entry(input);
		const b = generate_entry(input);

		expect(a).toBe(b);
	});

	test('identifier scheme is deterministic and zero-indexed', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/0.js', key: '/0.js', size: 1, etag: 'e0' },
				{ import_path: './client/1.js', key: '/1.js', size: 1, etag: 'e1' },
				{ import_path: './client/2.js', key: '/2.js', size: 1, etag: 'e2' }
			],
			prerendered_assets: [
				{ import_path: './prerendered/a.html', key: '/a', size: 1, etag: 'ea' },
				{ import_path: './prerendered/b.html', key: '/b', size: 1, etag: 'eb' }
			],
			server_assets: [{ import_path: './server/s.bin', key: 's.bin' }]
		});

		expect(output).toContain('_client_0');
		expect(output).toContain('_client_1');
		expect(output).toContain('_client_2');
		expect(output).not.toContain('_client_3');

		expect(output).toContain('_prerendered_0');
		expect(output).toContain('_prerendered_1');
		expect(output).not.toContain('_prerendered_2');

		expect(output).toContain('_server_0');
		expect(output).not.toContain('_server_1');
	});

	test('input order is preserved within each category', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/z.js', key: '/z.js', size: 1, etag: 'ez' },
				{ import_path: './client/a.js', key: '/a.js', size: 1, etag: 'ea' },
				{ import_path: './client/m.js', key: '/m.js', size: 1, etag: 'em' }
			],
			prerendered_assets: [],
			server_assets: []
		});

		const z_index = output.indexOf('_client_0 from "./client/z.js"');
		const a_index = output.indexOf('_client_1 from "./client/a.js"');
		const m_index = output.indexOf('_client_2 from "./client/m.js"');

		expect(z_index).toBeGreaterThan(-1);
		expect(a_index).toBeGreaterThan(z_index);
		expect(m_index).toBeGreaterThan(a_index);
	});

	test('imports are ordered: fixed first, then client, prerendered, server', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [{ import_path: './client/c.js', key: '/c.js', size: 1, etag: 'ec' }],
			prerendered_assets: [{ import_path: './prerendered/p.html', key: '/p', size: 1, etag: 'ep' }],
			server_assets: [{ import_path: './server/s.bin', key: 's.bin' }]
		});

		const server_fixed = output.indexOf('import { server }');
		const manifest_fixed = output.indexOf('import { prerendered');
		const start_fixed = output.indexOf('import { start }');
		const client_import = output.indexOf('_client_0');
		const prerendered_import = output.indexOf('_prerendered_0');
		const server_asset_import = output.indexOf('_server_0');

		expect(server_fixed).toBeGreaterThan(-1);
		expect(manifest_fixed).toBeGreaterThan(server_fixed);
		expect(start_fixed).toBeGreaterThan(manifest_fixed);
		expect(client_import).toBeGreaterThan(start_fixed);
		expect(prerendered_import).toBeGreaterThan(client_import);
		expect(server_asset_import).toBeGreaterThan(prerendered_import);
	});

	test('precompressed variants: snapshot', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{
					import_path: './client/app.js',
					key: '/app.js',
					size: 100,
					etag: 'etag-app',
					br: { import_path: './client/app.js.br', size: 40 },
					gz: { import_path: './client/app.js.gz', size: 60 }
				}
			],
			prerendered_assets: [
				{
					import_path: './prerendered/about.html',
					key: '/about',
					size: 200,
					etag: 'etag-about',
					br: { import_path: './prerendered/about.html.br', size: 80 },
					gz: { import_path: './prerendered/about.html.gz', size: 120 }
				}
			],
			server_assets: []
		});

		expect(output).toMatchSnapshot();
	});

	test('precompress: false (no br/gz on entries) omits variant imports and fields', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/app.js', key: '/app.js', size: 100, etag: 'etag-app' }
			],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).not.toContain('_client_0_br');
		expect(output).not.toContain('_client_0_gz');
		expect(output).not.toContain('.br"');
		expect(output).not.toContain('.gz"');
		expect(output).toContain(
			'const client_assets = {\n\t"/app.js": { file: _client_0, size: 100, etag: "etag-app" }\n};'
		);
	});

	test('a variant on only one asset only emits imports/fields for that asset', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/a.js', key: '/a.js', size: 1, etag: 'ea' },
				{
					import_path: './client/b.png',
					key: '/b.png',
					size: 2,
					etag: 'eb',
					gz: { import_path: './client/b.png.gz', size: 1 }
				}
			],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).not.toContain('_client_0_gz');
		expect(output).not.toContain('_client_0_br');
		expect(output).toContain(
			'import _client_1_gz from "./client/b.png.gz" with { type: \'file\' };'
		);
		expect(output).not.toContain('_client_1_br');
		expect(output).toContain(
			'"/b.png": { file: _client_1, size: 2, etag: "eb", gz: { file: _client_1_gz, size: 1 } }'
		);
	});

	test('custom import paths are used verbatim (no normalization)', () => {
		const output = generate_entry({
			server_path: '../weird/server.mjs',
			manifest_path: './nested/m.js',
			serve_path: './serve.mjs',
			client_assets: [],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('import { server } from "../weird/server.mjs";');
		expect(output).toContain('import { prerendered, app_path, mime_types } from "./nested/m.js";');
		expect(output).toContain('import { start } from "./serve.mjs";');
	});
});
