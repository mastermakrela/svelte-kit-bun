import adapter from 'svelte-kit-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// SvelteKit 3 takes its configuration inline in the `sveltekit()` plugin rather
// than from `svelte.config.js`. The env vars let the test suite build the same
// fixture in different shapes (see `tests/integration/*.spec.ts`).
export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			adapter: adapter({
				out: process.env.ADAPTER_BUN_OUT ?? 'build',
				compile: process.env.ADAPTER_BUN_COMPILE !== 'false',
				precompress: process.env.ADAPTER_BUN_PRECOMPRESS !== 'false',
				envPrefix: process.env.ADAPTER_BUN_ENV_PREFIX ?? ''
			}),
			paths: {
				base: process.env.ADAPTER_BUN_BASE ?? '',
				origin: process.env.ADAPTER_BUN_ORIGIN
			}
		})
	],
	build: {
		// force every imported asset to be emitted as its own file so the adapter's
		// asset bundling path is exercised end-to-end (no inline data: URIs)
		assetsInlineLimit: 0
	}
});
