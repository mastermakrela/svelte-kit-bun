import { describe, expect, test } from 'vitest';
import { generate_entry } from '../src/codegen.js';

const defaults = {
	server_index_path: './server/index.js',
	manifest_path: './server/manifest.js',
	serve_path: './serve.js'
};

describe('generate_entry', () => {
	test('happy path: snapshot', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/favicon.png', key: '/favicon.png' },
				{
					import_path: './client/_app/immutable/chunks/abc.js',
					key: '/_app/immutable/chunks/abc.js'
				}
			],
			prerendered_assets: [{ import_path: './prerendered/about.html', key: '/about' }],
			server_assets: [{ import_path: './server/_app/immutable/assets/data.bin', key: 'data.bin' }]
		});

		expect(output).toMatchSnapshot();
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

		expect(output).toContain('import { Server } from "./server/index.js";');
		expect(output).toContain('import { manifest, prerendered } from "./server/manifest.js";');
		expect(output).toContain('import { start } from "./serve.js";');
		expect(output).toContain('await start({');

		// no triple-newline gaps
		expect(output).not.toMatch(/\n\n\n/);
	});

	test('only one category populated: client only', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [{ import_path: './client/a.js', key: '/a.js' }],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('import _client_0 from "./client/a.js" with { type: \'file\' };');
		expect(output).toContain('const client_assets = {\n\t"/a.js": _client_0\n};');
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

	test('special characters in keys and import paths survive JSON.stringify', () => {
		const output = generate_entry({
			...defaults,
			client_assets: [
				{ import_path: './client/with space.png', key: '/with space.png' },
				{ import_path: './client/quote".js', key: '/quote".js' },
				{ import_path: './client/emoji-\u{1F525}.txt', key: '/emoji-\u{1F525}.txt' },
				{ import_path: './client/slash/nested/file.js', key: '/slash/nested/file.js' }
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
				{ import_path: './client/a.png', key: '/a.png' },
				{ import_path: './client/b.png', key: '/b.png' }
			],
			prerendered_assets: [{ import_path: './prerendered/index.html', key: '/' }],
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
				{ import_path: './client/0.js', key: '/0.js' },
				{ import_path: './client/1.js', key: '/1.js' },
				{ import_path: './client/2.js', key: '/2.js' }
			],
			prerendered_assets: [
				{ import_path: './prerendered/a.html', key: '/a' },
				{ import_path: './prerendered/b.html', key: '/b' }
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
				{ import_path: './client/z.js', key: '/z.js' },
				{ import_path: './client/a.js', key: '/a.js' },
				{ import_path: './client/m.js', key: '/m.js' }
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
			client_assets: [{ import_path: './client/c.js', key: '/c.js' }],
			prerendered_assets: [{ import_path: './prerendered/p.html', key: '/p' }],
			server_assets: [{ import_path: './server/s.bin', key: 's.bin' }]
		});

		const server_fixed = output.indexOf('import { Server }');
		const manifest_fixed = output.indexOf('import { manifest');
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

	test('custom import paths are used verbatim (no normalization)', () => {
		const output = generate_entry({
			server_index_path: '../weird/server.mjs',
			manifest_path: './nested/m.js',
			serve_path: './serve.mjs',
			client_assets: [],
			prerendered_assets: [],
			server_assets: []
		});

		expect(output).toContain('import { Server } from "../weird/server.mjs";');
		expect(output).toContain('import { manifest, prerendered } from "./nested/m.js";');
		expect(output).toContain('import { start } from "./serve.mjs";');
	});
});
