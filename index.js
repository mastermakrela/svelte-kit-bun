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
	const { out = 'build', binaryName = 'app', envPrefix = '', compile = true, targets, windows } = opts;

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
			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			const base = builder.config.kit.paths.base;

			builder.log.minor('Copying assets');
			const client_files = builder.writeClient(`${out}/client${base}`);
			builder.writePrerendered(`${out}/prerendered${base}`);

			builder.log.minor('Building server');
			builder.writeServer(`${out}/server`);

			await Bun.write(
				`${out}/server/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`
				].join('\n\n')
			);

			builder.copy(files, out);

			// writeClient returns paths relative to `${out}/client${base}`; the on-disk
			// layout under `${out}/client` carries the base prefix, so reconstruct it.
			const base_segment = base ? `${base.slice(1)}/` : '';

			/** @type {import('./src/codegen.js').AssetEntry[]} */
			const client_assets = client_files.map((rel) => ({
				import_path: `./client/${base_segment}${rel}`,
				key: `/${base_segment}${rel}`
			}));

			// Prerendered pages: URL key may differ from on-disk filename
			// (e.g. `/foo` → `foo.html`), so use builder.prerendered.pages as source of truth.
			/** @type {import('./src/codegen.js').AssetEntry[]} */
			const prerendered_assets = [];
			for (const [url_path, { file }] of builder.prerendered.pages) {
				prerendered_assets.push({
					import_path: `./prerendered/${base_segment}${file}`,
					key: url_path
				});
			}
			// Non-HTML prerendered assets: URL path mirrors the on-disk layout.
			for (const [url_path] of builder.prerendered.assets) {
				prerendered_assets.push({
					import_path: `./prerendered${url_path}`,
					key: url_path
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
				server_index_path: './server/index.js',
				manifest_path: './server/manifest.js',
				serve_path: './serve.js',
				client_assets,
				prerendered_assets,
				server_assets,
				env_prefix: envPrefix
			});

			await Bun.write(`${out}/entry.js`, entry_source);

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
						builder.log.minor(
							`Applying \`windows\` icon/metadata to ${outfile.slice(out.length + 1)} (post-processed; cross-compiled from ${process.platform})`
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

						const exe_bytes = await Bun.file(outfile).arrayBuffer();
						const patched = apply_windows_branding(exe_bytes, windows, icon_bytes);
						await Bun.write(outfile, patched);

						builder.log.warn(
							`@sveltejs/adapter-bun: \`windows\` icon/metadata for ${outfile.slice(out.length + 1)} ` +
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
				/** @type {unknown} */
				let pkg;
				try {
					pkg = await pkg_file.json();
				} catch (err) {
					builder.log.warn(
						`@sveltejs/adapter-bun: could not parse package.json to check for native addons: ${err}`
					);
					pkg = null;
				}
				if (pkg && typeof pkg === 'object') {
					const combined = {
						.../** @type {Record<string, unknown>} */ (
							/** @type {Record<string, unknown>} */ (pkg).dependencies ?? {}
						),
						.../** @type {Record<string, unknown>} */ (
							/** @type {Record<string, unknown>} */ (pkg).devDependencies ?? {}
						),
						.../** @type {Record<string, unknown>} */ (
							/** @type {Record<string, unknown>} */ (pkg).optionalDependencies ?? {}
						)
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
			read: () => true
		}
	};
}
