import * as path from "node:path";

/** @param {import('./index.d.ts').AdapterOptions} options */
export default function (options = {}) {
	/** @type {import('@sveltejs/kit').Adapter} */
	const adapter = {
		name: "svelte-kit-bun",
		supports: {
			// well if node can, then bun can too
			read: () => true,
		},
		async emulate() {
			return {
				platform({ config, prerender }) {
					return {
						/** @type {import('bun').Server} - we type it here to get rid of the TS error */
						get server() {
							// TODO: figure out how/if it could work in dev mode
							throw new Error("Currently not available in dev mode.");
						},
					};
				},
			};
		},
		async adapt(builder) {
			// Prepare the temp directory
			const tmp = builder.getBuildDirectory("bun");
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			const prerendered_dir = `${tmp}/prerendered`;
			builder.mkdirp(prerendered_dir);
			builder.writePrerendered(prerendered_dir);

			const client_dir = `${tmp}/client`;
			builder.mkdirp(client_dir);
			const client_files = builder.writeClient(client_dir);

			// Copy the server files (to be bundled with Bun)
			const server_dir = `${tmp}/server`;
			builder.mkdirp(server_dir);
			builder.writeServer(server_dir);

			const prerendered_imports = prepare_prerendered(builder.prerendered);
			const client_imports = prepare_client(client_files, builder.getAppPath());

			// Copy the entry point (to be bundled with Bun)
			const sk_server_relative_path = path.posix.relative(tmp, builder.getServerDirectory());
			builder.copy(`${import.meta.dir}/src/index.js`, `${tmp}/index.js`, {
				replace: {
					SERVER: `${sk_server_relative_path}/index.js`,
					MANIFEST: builder.generateManifest({ relativePath: sk_server_relative_path }),
					APP_PATH: JSON.stringify(builder.getAppPath()),
					IMPORTS: prerendered_imports.imports + client_imports.imports,
					STATIC_ROUTES: prerendered_imports.static_routes + client_imports.static_routes,
				},
			});

			builder.rimraf("build");
			const result = await Bun.build({
				throw: false,
				entrypoints: [`${tmp}/index.js`],
				outdir: "build",
				publicPath: "./build/",
				target: "bun",
				banner: `
// This file was generated by svelte-kit-bun
// https://github.com/mastermakrela/svelte-kit-bun
`,
			});

			if (result.success) {
				builder.log.success("[svelte-kit-bun]\tBuilt successfully.");
			} else {
				builder.log.error("[svelte-kit-bun]\tBuild failed.");
				result.logs.forEach((log) => {
					// TODO: replace with builder.log.error
					console.error(log);
				});
			}
		},
	};

	return adapter;
}

const symbols = /[/.-]/g;

/**
 * @param {import("@sveltejs/kit").Builder["prerendered"]} prerendered
 */
function prepare_prerendered(prerendered) {
	const template = 'import FILENAME from "./prerenderedPATH";\n';

	let imports = "";
	let static_routes = "";

	imports += "\n// Redirects\n";

	for (const [pathname, { status, location }] of prerendered.redirects) {
		const filepath = `${pathname}.html`;
		const filename = filepath.replaceAll(symbols, "_");

		imports += template.replace("FILENAME", filename).replace("PATH", filepath);
		static_routes += `\t"${pathname}": await _redirect(${filename}, "${location}", ${status}),\n`;
	}

	imports += "\n// Assets\n";

	for (const [pathname, { type }] of prerendered.assets) {
		const filepath = `${pathname}`;
		const filename = filepath.replaceAll(symbols, "_");
		const bun_file = `${filename}_file`;

		imports += template.replace("FILENAME", filename).replace("PATH", filepath);
		static_routes += `\t"${pathname}": await _file(${filename}, "${type}"),\n`;
	}

	imports += "\n// Pages\n";

	for (const [pathname, { file }] of prerendered.pages) {
		const filepath = `/${file}`;
		const filename = filepath.replaceAll(symbols, "_");

		imports += template.replace("FILENAME", filename).replace("PATH", filepath);
		// would be nice to use Bun's HTML imports, but they don't work with `bun build`, yet
		// static_routes += `\t"${pathname}": ${filename},\n`;
		static_routes += `\t"${pathname}": await _file(${filename}),\n`;
	}

	return { imports, static_routes };
}

/**
 * @param {string[]} client_files
 * @param {string} app_path
 */
function prepare_client(client_files, app_path) {
	let imports = "";
	let static_routes = "";

	imports += "\n// Client files\n";

	for (const path of client_files) {
		const immutable = path.startsWith(`${app_path}/immutable/`);
		const filename = path.replaceAll(symbols, "_");

		imports += `import ${filename} from "./client/${path}" with { type: "file" };\n`;

		if (immutable) {
			static_routes += `\t"/${path}": await _immutable(${filename}),\n`;
		} else {
			static_routes += `\t"/${path}": await _file(${filename}),\n`;
		}
	}

	return { imports, static_routes };
}
