import adapter from 'svelte-kit-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// The env vars let the test suite build the same fixture in different shapes
// (see `tests/integration/*.spec.ts`).
/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			out: process.env.ADAPTER_BUN_OUT ?? 'build',
			compile: process.env.ADAPTER_BUN_COMPILE !== 'false',
			precompress: process.env.ADAPTER_BUN_PRECOMPRESS !== 'false',
			envPrefix: process.env.ADAPTER_BUN_ENV_PREFIX ?? ''
		}),
		paths: {
			base: process.env.ADAPTER_BUN_BASE ?? ''
		},
		experimental: {
			// `src/instrumentation.server.js` only exists for instrumented test builds
			instrumentation: { server: true }
		}
	}
};

export default config;
