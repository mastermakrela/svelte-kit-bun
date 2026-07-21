import { Adapter } from '@sveltejs/kit';
import './ambient.js';

interface AdapterOptions {
	/**
	 * Output directory for the compiled executable and intermediate files.
	 * @default 'build'
	 */
	out?: string;

	/**
	 * Whether to compile a single-file executable via `Bun.build --compile`.
	 * When `false`, the adapter emits `${out}/entry.js` alongside the bundled
	 * assets and you run the app with `bun run ${out}/entry.js`. Useful for
	 * environments where you prefer to ship the source plus a Bun runtime
	 * rather than a standalone binary (e.g. containers, faster iteration).
	 * @default true
	 */
	compile?: boolean;

	/**
	 * Name of the output executable (without platform-specific extension).
	 * Ignored when `compile` is `false`.
	 * @default 'app'
	 */
	binaryName?: string;

	/**
	 * Prefix for SvelteKit-specific environment variables. Useful when running
	 * alongside other processes that use conflicting variable names.
	 * @default ''
	 */
	envPrefix?: string;

	/**
	 * Cross-compile targets. When set, produces one binary per target named
	 * `${binaryName}-${target}` under `out`. Omit to build a single binary for
	 * the host platform, named `${binaryName}`. Ignored when `compile` is `false`.
	 *
	 * Valid targets (from Bun's `bun build --compile --target=...`):
	 * `bun-linux-x64`, `bun-linux-x64-modern`, `bun-linux-x64-baseline`,
	 * `bun-linux-x64-musl`, `bun-linux-arm64`, `bun-linux-arm64-musl`,
	 * `bun-darwin-x64`, `bun-darwin-arm64`,
	 * `bun-windows-x64`, `bun-windows-x64-modern`, `bun-windows-x64-baseline`.
	 *
	 * @default undefined
	 */
	targets?: string[];

	/**
	 * Icon and version metadata to embed in the compiled Windows executable,
	 * mirroring `Bun.build`'s `compile.windows` shape. Only applied when a
	 * Windows binary is actually being produced (a `bun-windows-*` target, or
	 * the implicit host build when running on Windows itself).
	 *
	 * **When building natively on Windows**, this is passed straight through
	 * to Bun's own `compile.windows`.
	 *
	 * **When cross-compiling a `bun-windows-*` target from macOS/Linux**, Bun
	 * itself silently ignores these fields (its Windows resource embedding
	 * depends on Windows APIs — see
	 * https://bun.sh/docs/bundler/executables#windows-specific-flags). Since
	 * that's this adapter's main real-world use case, the adapter instead
	 * post-processes the compiled executable's PE resources directly (icon,
	 * version info) and, for `hideConsole`, the subsystem flag. This has been
	 * verified structurally — resource content, section table layout, PE
	 * checksum, and the integrity of Bun's own embedded-asset payload were all
	 * confirmed unchanged apart from the intended edits — but the resulting
	 * executable has not been run on Windows as part of that verification.
	 * Confirm it launches correctly before shipping it.
	 */
	windows?: {
		/** Path to a `.ico` file to embed as the executable's icon. */
		icon?: string;
		/** Suppress the console window when the executable runs. */
		hideConsole?: boolean;
		/** Product name shown in the executable's version info / Properties dialog. */
		title?: string;
		/** Company/publisher name shown in the executable's version info. */
		publisher?: string;
		/** Version string, e.g. `1.2.3.4`. */
		version?: string;
		/** File description shown in the executable's version info. */
		description?: string;
		/** Copyright string shown in the executable's version info. */
		copyright?: string;
	};
}

export default function plugin(options?: AdapterOptions): Adapter;
