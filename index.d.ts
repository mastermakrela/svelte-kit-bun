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
}

export default function plugin(options?: AdapterOptions): Adapter;
