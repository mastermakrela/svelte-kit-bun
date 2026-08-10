import { defineConfig } from 'vitest/config';

/**
 * The suite must run under Vitest, not `bun test`: the unit specs rely on
 * `vi.stubGlobal` / `vi.mock` / `vi.mocked`, which Bun's built-in runner does not
 * provide (see `bunfig.toml`, which turns a stray `bun test` into a clear error).
 *
 * Two projects:
 * - `unit` — pure, in-process specs (codegen, `index.js`'s `adapt` with a mocked
 *   `Bun`, and `serve.js`'s exported helpers). No app builds, seconds to run.
 * - `integration` — specs that shell out to `bun`: they build the SvelteKit 3
 *   fixture app (`tests/fixtures/basic-app`), run the resulting single-file
 *   executable (or `bun build/entry.js`) and assert over real HTTP.
 *
 * Run one project on its own with `bun run test:unit` / `bun run test:integration`.
 */
export default defineConfig({
	test: {
		// The integration specs all build the same fixture app, which means they share
		// `tests/fixtures/basic-app/.svelte-kit` (and, for instrumented builds, its
		// `src/`). Running spec files in parallel lets one build delete another's
		// intermediate output, so builds must not overlap.
		fileParallelism: false,
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['tests/*.spec.ts']
				}
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: ['tests/integration/*.spec.ts'],
					// building and compiling an app is slow; the default 5s never applies here
					testTimeout: 60_000,
					hookTimeout: 300_000
				}
			}
		]
	}
});
