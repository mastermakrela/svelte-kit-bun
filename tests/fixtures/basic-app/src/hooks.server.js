// Server hooks are loaded by `server.init()` at startup, i.e. as part of the
// application graph — so appending here records the position of app code relative
// to `instrumentation.server.js` (see the fixture root's copy of that file).
(globalThis.__adapter_bun_load_order ??= []).push('app');
