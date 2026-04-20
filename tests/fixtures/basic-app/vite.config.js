import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		// force every imported asset to be emitted as its own file so the adapter's
		// asset bundling path is exercised end-to-end (no inline data: URIs)
		assetsInlineLimit: 0
	}
});
