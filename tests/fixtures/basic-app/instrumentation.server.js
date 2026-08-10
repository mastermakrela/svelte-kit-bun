// Template for `src/instrumentation.server.js`. It lives in the fixture root (where
// SvelteKit does not look for it) so the test suite can build this same app both with
// and without server instrumentation — `build_fixture({ instrumentation: true })`
// copies it into `src/` for the duration of the build.
//
// A real instrumentation module would register OpenTelemetry SDK/module hooks here.
// This one just records that it ran, and *when* it ran relative to app code.
(globalThis.__adapter_bun_load_order ??= []).push('instrumentation');

// unique string so a test can assert the compiled executable really embeds this module
globalThis.__adapter_bun_instrumentation_marker = 'INSTRUMENTATION_MARKER_9f3a71';
