import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { generate_entry } from './src/codegen.js';
import { apply_windows_branding } from './src/windows-brand.js';

const files = `${import.meta.dirname}/files`;

/**
 * Packages that ship precompiled N-API native addons — cannot be embedded
 * inside a Bun single-file executable.
 */
const NATIVE_ADDON_PACKAGES = [
	'sharp',
	'better-sqlite3',
	'argon2',
	'canvas',
	'@mapbox/node-pre-gyp'
];

/**
 * Dotfiles are not embedded, with the customary exception of `.well-known/`,
 * mirroring upstream adapter-node's `is_hidden`.
 * @param {string} file - relative to the client output dir, no leading slash
 */
function is_hidden(file) {
	return (
		file.split('/').some((segment) => segment.startsWith('.')) && !file.startsWith('.well-known/')
	);
}

/**
 * Size and content hash (sha256, base64url) from one pass over the file, a buffer
 * at a time, mirroring upstream adapter-node's `measure` — so large embedded
 * assets are neither read fully into memory nor hashed twice.
 * @param {string} path
 * @param {Buffer} buffer
 * @returns {{ size: number, etag: string }}
 */
function measure(path, buffer) {
	const fd = openSync(path, 'r');
	const hash = createHash('sha256');
	let size = 0;

	try {
		let read;
		while ((read = readSync(fd, buffer)) > 0) {
			hash.update(buffer.subarray(0, read));
			size += read;
		}
	} finally {
		closeSync(fd);
	}

	return { size, etag: hash.digest('base64url') };
}

/**
 * A build job's target is a Windows one if it explicitly names a
 * `bun-windows-*` triple, or — when no target is given — the host running
 * the build is Windows itself (Bun then compiles for the host).
 * @param {string | undefined} target
 */
function is_windows_target(target) {
	return target ? target.startsWith('bun-windows') : process.platform === 'win32';
}

/** @type {import('./index.js').default} */
export default function plugin(opts = {}) {
	const {
		out = 'build',
		binaryName = 'app',
		envPrefix = '',
		compile = true,
		precompress = true,
		targets,
		windows
	} = opts;

	return {
		name: '@sveltejs/adapter-bun',

		/** @param {import('@sveltejs/kit').Builder} builder */
		async adapt(builder) {
			if (typeof globalThis.Bun === 'undefined') {
				throw new Error(
					'@sveltejs/adapter-bun: Bun runtime not detected. ' +
						'Invoke your build under Bun (e.g. `bun run build`).'
				);
			}

			const tmp = builder.getBuildDirectory('adapter-bun');
			rmSync(out, { force: true, recursive: true });
			rmSync(tmp, { force: true, recursive: true });
			mkdirSync(tmp, { recursive: true });

			const base = builder.config.paths.base;

			const client_dir = `${out}/client${base}`;
			const prerendered_dir = `${out}/prerendered${base}`;

			builder.log.minor('Copying assets');
			const client_files = builder.writeClient(client_dir);
			builder.writePrerendered(prerendered_dir);

			builder.log.minor(precompress ? 'Compressing assets' : 'Skipping precompression');
			// `builder.compress` always writes a `.gz` *and* a `.br` sibling for every file it
			// returns (never just one), so membership in the returned list is enough to know
			// both variants exist — no need to check each on disk separately.
			const [client_compressed, prerendered_compressed] = precompress
				? await Promise.all([builder.compress(client_dir), builder.compress(prerendered_dir)])
				: [[], []];
			const client_compressed_set = new Set(client_compressed);
			const prerendered_compressed_set = new Set(prerendered_compressed);

			builder.log.minor('Building server');
			const server_dir = `${out}/server`;
			builder.writeServer(server_dir);
			builder.generateServerInstance(`${server_dir}/server.js`, { serverDirectory: server_dir });

			// values only known after the build
			await Bun.write(
				`${server_dir}/manifest.js`,
				[
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const app_path = ${JSON.stringify(builder.getAppPath())};`,
					`export const mime_types = ${JSON.stringify(builder.mimeTypes)};`
				].join('\n')
			);

			builder.copy(files, out);

			// writeClient returns paths relative to `${out}/client${base}`; the on-disk
			// layout under `${out}/client` carries the base prefix, so reconstruct it.
			const base_segment = base ? `${base.slice(1)}/` : '';

			// one shared buffer for every `measure()` call below, mirroring upstream's `measure_files`
			const hash_buffer = Buffer.allocUnsafe(64 * 1024);

			// `builder.compress` returns paths relative to the directory it compressed, matching
			// `rel` below one-for-one — when present there, both `.br` and `.gz` siblings exist.
			/**
			 * @param {string} rel
			 * @param {string} path - on-disk path to the uncompressed file (same as passed to `measure`)
			 * @param {string} import_path - import path to the uncompressed file
			 * @param {Set<string>} compressed_set
			 */
			function compressed_variants(rel, path, import_path, compressed_set) {
				if (!compressed_set.has(rel)) return {};
				return {
					br: { import_path: `${import_path}.br`, size: statSync(`${path}.br`).size },
					gz: { import_path: `${import_path}.gz`, size: statSync(`${path}.gz`).size }
				};
			}

			// Dotfiles are skipped before they're even imported into entry.js, so they
			// never end up embedded in the executable.
			/** @type {import('./src/codegen.js').AssetEntry[]} */
			const client_assets = client_files
				.filter((rel) => !is_hidden(rel))
				.map((rel) => {
					const path = `${client_dir}/${rel}`;
					const { size, etag } = measure(path, hash_buffer);
					const import_path = `./client/${base_segment}${rel}`;
					return {
						import_path,
						key: `/${base_segment}${rel}`,
						size,
						etag,
						...compressed_variants(rel, path, import_path, client_compressed_set)
					};
				});

			// Prerendered pages: URL key may differ from on-disk filename
			// (e.g. `/foo` → `foo.html`), so use builder.prerendered.pages as source of truth.
			/** @type {import('./src/codegen.js').AssetEntry[]} */
			const prerendered_assets = [];
			for (const [url_path, { file }] of builder.prerendered.pages) {
				const path = `${prerendered_dir}/${file}`;
				const { size, etag } = measure(path, hash_buffer);
				const import_path = `./prerendered/${base_segment}${file}`;
				prerendered_assets.push({
					import_path,
					key: url_path,
					size,
					etag,
					...compressed_variants(file, path, import_path, prerendered_compressed_set)
				});
			}
			// Non-HTML prerendered assets: URL path mirrors the on-disk layout.
			for (const [url_path] of builder.prerendered.assets) {
				const rel = url_path.slice(base.length + 1);
				if (is_hidden(rel)) continue;
				const path = `${out}/prerendered${url_path}`;
				const { size, etag } = measure(path, hash_buffer);
				const import_path = `./prerendered${url_path}`;
				prerendered_assets.push({
					import_path,
					key: url_path,
					size,
					etag,
					...compressed_variants(rel, path, import_path, prerendered_compressed_set)
				});
			}

			// `name` is already relative to the server output dir (e.g.
			// `_app/immutable/assets/greeting.hash.txt`).
			/** @type {import('./src/codegen.js').AssetEntry[]} */
			const server_assets = builder.findServerAssets(builder.routes).map((name) => ({
				import_path: `./server/${name}`,
				key: name
			}));

			const entry_source = generate_entry({
				server_path: './server/server.js',
				manifest_path: './server/manifest.js',
				serve_path: './serve.js',
				client_assets,
				prerendered_assets,
				server_assets,
				// `paths.origin` is baked in at build time (Kit validates and
				// normalizes it); when unset the runtime derives the origin from the
				// request and any configured proxy headers.
				origin: builder.config.paths.origin,
				env_prefix: envPrefix
			});

			await Bun.write(`${out}/entry.js`, entry_source);

			// `writeServer` already copied `instrumentation.server.js` into `${out}/server`,
			// so all that's left is to turn `entry.js` into a facade that imports it before
			// dynamically importing the real entry (renamed to `start.js`). Bun.build then
			// compiles the facade, embedding both graphs in the executable.
			if (builder.hasServerInstrumentationFile()) {
				builder.log.minor('Instrumenting entry point');
				builder.instrument({
					entrypoint: `${out}/entry.js`,
					instrumentation: `${server_dir}/instrumentation.server.js`,
					// populates `$env/dynamic/private` from `process.env` before the
					// instrumentation runs; it lives next to the server output so the facade's
					// relative import resolves when Bun.build bundles it
					initializer: builder.createInstrumentationInitializer({
						outputDirectory: server_dir,
						serverDirectory: server_dir
					}),
					// the generated entry is a side-effect-only script (`await start({...})`),
					// so there is nothing to re-export from the renamed module
					module: { exports: [] }
				});
			}

			if (!compile) {
				builder.log.minor(`Skipping executable compile; run with \`bun run ${out}/entry.js\``);
				return;
			}

			const build_jobs =
				targets && targets.length > 0
					? targets.map((target) => ({ target, outfile: `${out}/${binaryName}-${target}` }))
					: [
							{
								target: /** @type {string | undefined} */ (undefined),
								outfile: `${out}/${binaryName}`
							}
						];

			if (windows && !build_jobs.some((job) => is_windows_target(job.target))) {
				builder.log.warn(
					'@sveltejs/adapter-bun: `windows` option was set but no Windows target is being built; ignoring.'
				);
			}

			await Promise.all(
				build_jobs.map(async ({ target, outfile }) => {
					const windows_job = is_windows_target(target);
					const cross_compiling_windows = windows_job && process.platform !== 'win32';

					builder.log.minor(
						`Compiling single-file executable (${outfile.slice(out.length + 1)}${
							target ? ` for ${target}` : ''
						})`
					);

					/** @type {Record<string, unknown>} */
					const compile_opts = { outfile };
					if (target) compile_opts.target = target;
					// Bun silently ignores `compile.windows` when cross-compiling (it depends on
					// Windows APIs), so only pass it through when actually building on Windows.
					if (windows && windows_job && !cross_compiling_windows) compile_opts.windows = windows;

					const result = await Bun.build({
						entrypoints: [`${out}/entry.js`],
						compile: compile_opts,
						target: 'bun'
					});

					if (!result.success) {
						for (const msg of result.logs) {
							builder.log.error(
								typeof msg === 'string' ? msg : (msg?.message ?? JSON.stringify(msg))
							);
						}
						throw new Error(
							`@sveltejs/adapter-bun: Bun.build --compile failed${target ? ` for ${target}` : ''}`
						);
					}

					if (windows && windows_job && cross_compiling_windows) {
						// Bun silently appends `.exe` to `outfile` for Windows targets when it's
						// missing an extension, so the file actually on disk isn't necessarily
						// `outfile` itself — `result.outputs` gives the real compiled path.
						const compiled_path =
							result.outputs.find((o) => o.kind === 'entry-point')?.path ?? outfile;

						builder.log.minor(
							`Applying \`windows\` icon/metadata to ${basename(compiled_path)} (post-processed; cross-compiled from ${process.platform})`
						);

						let icon_bytes = null;
						if (windows.icon) {
							const icon_file = Bun.file(windows.icon);
							if (!(await icon_file.exists())) {
								throw new Error(
									`@sveltejs/adapter-bun: \`windows.icon\` file not found: ${windows.icon}`
								);
							}
							icon_bytes = await icon_file.arrayBuffer();
						}

						const exe_bytes = await Bun.file(compiled_path).arrayBuffer();
						const patched = apply_windows_branding(exe_bytes, windows, icon_bytes);
						await Bun.write(compiled_path, patched);

						builder.log.warn(
							`@sveltejs/adapter-bun: \`windows\` icon/metadata for ${basename(compiled_path)} ` +
								`was embedded via post-processing, not Bun's own mechanism, because Bun ignores ` +
								`\`compile.windows\` when cross-compiling from ${process.platform}. This has been ` +
								'verified structurally (resource content, section table, PE checksum) but not by ' +
								'running the executable on Windows — please confirm it launches correctly before ' +
								'shipping it.'
						);
					}
				})
			);

			const pkg_file = Bun.file('package.json');
			if (await pkg_file.exists()) {
				/** @type {{ dependencies?: object, devDependencies?: object, optionalDependencies?: object } | null} */
				let pkg;
				try {
					pkg = await pkg_file.json();
				} catch (err) {
					builder.log.warn(
						`@sveltejs/adapter-bun: could not parse package.json to check for native addons: ${err}`
					);
					pkg = null;
				}
				if (pkg) {
					const combined = {
						...pkg.dependencies,
						...pkg.devDependencies,
						...pkg.optionalDependencies
					};
					const offenders = NATIVE_ADDON_PACKAGES.filter((name) => name in combined);
					if (offenders.length > 0) {
						builder.log.warn(
							`@sveltejs/adapter-bun: detected ${offenders.join(', ')} in dependencies. ` +
								'N-API native addons cannot be embedded in a Bun single-file ' +
								'executable and will fail at runtime.'
						);
					}
				}
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		}
	};
}
