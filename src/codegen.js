/**
 * @typedef {Object} AssetEntry
 * @property {string} import_path - Path relative to entry.js used in `import ... with { type: "file" }`
 * @property {string} key - For client/prerendered this is the URL path served; for server assets it's the manifest._.server_assets key
 */

/**
 * @param {AssetEntry[]} entries
 * @param {string} prefix - identifier prefix (e.g. `_client`)
 * @returns {{ imports: string[], map: string }}
 */
function render_asset_group(entries, prefix) {
	/** @type {string[]} */
	const imports = [];
	/** @type {string[]} */
	const map_entries = [];

	for (let i = 0; i < entries.length; i++) {
		const id = `${prefix}_${i}`;
		const { import_path, key } = entries[i];
		imports.push(`import ${id} from ${JSON.stringify(import_path)} with { type: 'file' };`);
		map_entries.push(`\t${JSON.stringify(key)}: ${id}`);
	}

	const map = map_entries.length === 0 ? '{}' : `{\n${map_entries.join(',\n')}\n}`;

	return { imports, map };
}

/**
 * Generate the source of entry.js that Bun.build compiles into a single-file executable.
 *
 * @param {Object} options
 * @param {string} options.server_index_path - relative import path from entry.js to server/index.js
 * @param {string} options.manifest_path     - relative import path from entry.js to server/manifest.js
 * @param {string} options.serve_path        - relative import path from entry.js to serve.js
 * @param {AssetEntry[]} options.client_assets      - key = URL path
 * @param {AssetEntry[]} options.prerendered_assets - key = URL path
 * @param {AssetEntry[]} options.server_assets      - key = manifest._.server_assets entry name
 * @param {string} [options.env_prefix]             - optional prefix for HOST, PORT, etc.
 * @returns {string}
 */
export function generate_entry({
	server_index_path,
	manifest_path,
	serve_path,
	client_assets,
	prerendered_assets,
	server_assets,
	env_prefix = ''
}) {
	const client = render_asset_group(client_assets, '_client');
	const prerendered = render_asset_group(prerendered_assets, '_prerendered');
	const server = render_asset_group(server_assets, '_server');

	const fixed_imports = [
		`import { Server } from ${JSON.stringify(server_index_path)};`,
		`import { manifest, prerendered } from ${JSON.stringify(manifest_path)};`,
		`import { start } from ${JSON.stringify(serve_path)};`
	];

	const asset_imports = [...client.imports, ...prerendered.imports, ...server.imports];

	const start_args = [
		'\tServer,',
		'\tmanifest,',
		'\tprerendered,',
		'\tclient_assets,',
		'\tprerendered_assets,',
		'\tserver_assets'
	];

	if (env_prefix !== '') {
		start_args[start_args.length - 1] += ',';
		start_args.push(`\tenv_prefix: ${JSON.stringify(env_prefix)}`);
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
		...start_args,
		'});',
		''
	];

	if (asset_imports.length === 0) {
		return lines.filter((line, i) => !(line === '' && lines[i - 1] === '')).join('\n');
	}

	return lines.join('\n');
}
