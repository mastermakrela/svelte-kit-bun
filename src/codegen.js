/**
 * @typedef {Object} CompressedVariant
 * @property {string} import_path - Path relative to entry.js used in `import ... with { type: "file" }`
 * @property {number} size - compressed file size in bytes, computed at build time
 */

/**
 * @typedef {Object} AssetEntry
 * @property {string} import_path - Path relative to entry.js used in `import ... with { type: "file" }`
 * @property {string} key - For client/prerendered this is the URL path served; for server assets it's the manifest._.server_assets key
 * @property {string} [etag] - sha256/base64url content hash, computed at build time (client/prerendered only)
 * @property {number} [size] - file size in bytes, computed at build time (client/prerendered only)
 * @property {CompressedVariant} [br] - precompressed brotli variant, when `precompress` produced one
 * @property {CompressedVariant} [gz] - precompressed gzip variant, when `precompress` produced one
 */

/**
 * @param {AssetEntry[]} entries
 * @param {string} prefix - identifier prefix (e.g. `_client`)
 * @param {boolean} with_metadata - emit `{ file, etag, size }` instead of a bare identifier
 *   (client/prerendered assets carry build-time etag/size for `create_file_map`; server assets don't need it)
 * @returns {{ imports: string[], map: string }}
 */
function render_asset_group(entries, prefix, with_metadata) {
	/** @type {string[]} */
	const imports = [];
	/** @type {string[]} */
	const map_entries = [];

	for (let i = 0; i < entries.length; i++) {
		const id = `${prefix}_${i}`;
		const { import_path, key, etag, size, br, gz } = entries[i];
		imports.push(`import ${id} from ${JSON.stringify(import_path)} with { type: 'file' };`);

		let value = id;
		if (with_metadata) {
			const fields = [
				`file: ${id}`,
				`size: ${JSON.stringify(size)}`,
				`etag: ${JSON.stringify(etag)}`
			];

			for (const [variant_name, variant] of /** @type {const} */ ([
				['br', br],
				['gz', gz]
			])) {
				if (!variant) continue;
				const variant_id = `${id}_${variant_name}`;
				imports.push(
					`import ${variant_id} from ${JSON.stringify(variant.import_path)} with { type: 'file' };`
				);
				fields.push(
					`${variant_name}: { file: ${variant_id}, size: ${JSON.stringify(variant.size)} }`
				);
			}

			value = `{ ${fields.join(', ')} }`;
		}
		map_entries.push(`\t${JSON.stringify(key)}: ${value}`);
	}

	const map = map_entries.length === 0 ? '{}' : `{\n${map_entries.join(',\n')}\n}`;

	return { imports, map };
}

/**
 * Generate the source of entry.js that Bun.build compiles into a single-file executable.
 *
 * @param {Object} options
 * @param {string} options.server_path       - relative import path from entry.js to the module exporting the `server` instance
 * @param {string} options.manifest_path     - relative import path from entry.js to the module exporting `prerendered`, `app_path` and `mime_types`
 * @param {string} options.serve_path        - relative import path from entry.js to serve.js
 * @param {AssetEntry[]} options.client_assets      - key = URL path
 * @param {AssetEntry[]} options.prerendered_assets - key = URL path
 * @param {AssetEntry[]} options.server_assets      - key = manifest._.server_assets entry name
 * @param {string} [options.origin]                 - `paths.origin`, baked in at build time
 * @param {string} [options.env_prefix]             - optional prefix for HOST, PORT, etc.
 * @returns {string}
 */
export function generate_entry({
	server_path,
	manifest_path,
	serve_path,
	client_assets,
	prerendered_assets,
	server_assets,
	origin,
	env_prefix = ''
}) {
	const client = render_asset_group(client_assets, '_client', true);
	const prerendered = render_asset_group(prerendered_assets, '_prerendered', true);
	const server = render_asset_group(server_assets, '_server', false);

	const fixed_imports = [
		`import { server } from ${JSON.stringify(server_path)};`,
		`import { prerendered, app_path, mime_types } from ${JSON.stringify(manifest_path)};`,
		`import { start } from ${JSON.stringify(serve_path)};`
	];

	const asset_imports = [...client.imports, ...prerendered.imports, ...server.imports];

	const start_args = [
		'server',
		'prerendered',
		'app_path',
		'mime_types',
		'client_assets',
		'prerendered_assets',
		'server_assets'
	];

	if (origin !== undefined) {
		start_args.push(`origin: ${JSON.stringify(origin)}`);
	}

	if (env_prefix !== '') {
		start_args.push(`env_prefix: ${JSON.stringify(env_prefix)}`);
	}

	const lines = [
		...fixed_imports,
		'',
		...asset_imports,
		'',
		`const client_assets = ${client.map};`,
		`const prerendered_assets = ${prerendered.map};`,
		`const server_assets = ${server.map};`,
		'',
		'await start({',
		start_args.map((arg) => `\t${arg}`).join(',\n'),
		'});',
		''
	];

	if (asset_imports.length === 0) {
		return lines.filter((line, i) => !(line === '' && lines[i - 1] === '')).join('\n');
	}

	return lines.join('\n');
}
