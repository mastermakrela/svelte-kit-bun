/// <reference lib="webworker" />

// Minimal service worker — used by the adapter-bun smoke test to confirm
// SvelteKit's emitted /service-worker.js is embedded and served correctly.
self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});
