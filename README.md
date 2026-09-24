# @sveltejs/adapter-bun

**Experimental.** Adapter for SvelteKit apps that compiles the app into a [Bun single-file executable](https://bun.com/docs/bundler/executables). All static, prerendered, and server assets are embedded into the binary — the resulting file runs standalone with no external dependencies.

## Requirements

- [Bun](https://bun.com/) >= 1.2.17 — the build and the resulting binary both run under Bun.
- SvelteKit 3 `>= 3.0.0-next.27` (currently prerelease: `@sveltejs/kit@next`). This release line (`0.7`) uses the Kit 3 adapter API (`builder.generateServerInstance`, `builder.createInstrumentationInitializer`, `paths.origin`) and does not work with SvelteKit 2.

| SvelteKit      | svelte-kit-bun | install                          |
| -------------- | -------------- | -------------------------------- |
| 3 (prerelease) | `0.7.0-next.*` | `bun add -d svelte-kit-bun@next` |
| 2              | `0.6.x`        | `bun add -d svelte-kit-bun@0.6`  |

Until SvelteKit 3 is stable, the default (`latest`) install stays on `0.6.x`, mirroring upstream's `@sveltejs/adapter-node@5` (Kit 2) / `@6` (Kit 3) split.

## Caveats

- **No native (N-API) modules in single-file mode.** Packages that ship `.node` addons (`sharp`, `better-sqlite3`, `argon2`, `canvas`, etc.) cannot be embedded in the executable. WASM works. Native addons _do_ work if you set `compile: false`.
- **Read-only filesystem (single-file mode).** Embedded assets live in Bun's `$bunfs`, which is read-only. Persist any user data outside the binary.
- **Not yet supported:** service worker embedding, precompression, socket activation.

## Usage

SvelteKit 3 takes its configuration inline in the `sveltekit()` Vite plugin (there is no `svelte.config.js`):

```js
// vite.config.js
import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter()
    })
  ]
});
```

Run the build under Bun:

```sh
bun run build
```

Output: `build/app` (single-file executable).

### Skipping the executable

Set `compile: false` to emit `build/entry.js` and the asset tree without producing a standalone binary:

```js
adapter({ compile: false });
```

Then run `bun run build/entry.js`. This keeps native addons working and makes iteration faster at the cost of shipping Bun alongside the app.

### Precompression

`precompress` (default `true`) mirrors `@sveltejs/adapter-node`'s option of the same name: client and prerendered assets are additionally compressed with gzip and brotli at build time (via `builder.compress`, which only compresses certain text-like extensions — `.html`, `.js`, `.mjs`, `.json`, `.css`, `.svg`, `.xml`, `.wasm`, `.txt`, `.md`, `.mdx`), and both variants are embedded in the executable alongside the original.

```js
adapter({ precompress: false });
```

**Trade-off:** each compressible asset is embedded up to 3× (raw + gzip + brotli), so the executable grows. Set `precompress: false` for a smaller binary at the cost of the server always sending uncompressed bodies.

### Environment variables

The built app reads exactly these variables at startup — nothing else:

| Variable                  | Default   | Description                                                                                                                                            |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST`                    | `0.0.0.0` | Hostname to bind to. Ignored when `SOCKET_PATH` is set.                                                                                                |
| `PORT`                    | `3000`    | Port to listen on (integer, 0–65535). Ignored when `SOCKET_PATH` is set.                                                                               |
| `SOCKET_PATH`             | —         | Path to a unix socket to listen on instead of `HOST`/`PORT`. A stale empty file already at that path is removed before binding.                        |
| `ADDRESS_HEADER`          | —         | Header to read the client address from, e.g. `X-Forwarded-For`. Without it, the socket address is used.                                                |
| `XFF_DEPTH`               | `1`       | How many trusted proxies sit in front of the app, counted from the right of `X-Forwarded-For`.                                                         |
| `PROTOCOL_HEADER`         | —         | Header carrying the forwarded protocol, e.g. `X-Forwarded-Proto`. Without it, the derived origin defaults to `https`.                                  |
| `HOST_HEADER`             | —         | Header carrying the forwarded host, e.g. `X-Forwarded-Host`.                                                                                           |
| `PORT_HEADER`             | —         | Header carrying the forwarded port, e.g. `X-Forwarded-Port`.                                                                                           |
| `BODY_SIZE_LIMIT`         | `512K`    | Maximum request body size; a number of bytes, optionally suffixed with `K`, `M` or `G`.                                                                |
| `SHUTDOWN_TIMEOUT`        | `30`      | Seconds to wait for in-flight requests to finish after `SIGTERM`/`SIGINT` before connections are closed forcibly.                                      |
| `CONNECTION_IDLE_TIMEOUT` | `0`       | Seconds `Bun.serve` lets a connection sit idle before closing it; `0` disables the timeout, the maximum is `255`. See [Idle timeouts](#idle-timeouts). |

Set [`envPrefix`](#usage) to namespace them (`envPrefix: 'MY_APP_'` → `MY_APP_PORT`). As in `@sveltejs/adapter-node`, the app then **refuses to start** if any _other_ variable carries that prefix, since that almost always means the prefix collides with something else in the environment:

```
Error: You should change envPrefix (MY_APP_) to avoid conflicts with existing
environment variables — unexpectedly saw MY_APP_DATABASE_URL
```

Invalid values (a non-numeric `PORT`, a `CONNECTION_IDLE_TIMEOUT` above 255, …) also fail at startup rather than being silently corrected.

#### Idle timeouts

`Bun.serve` closes a connection after 10 seconds of inactivity by default, and counts an in-flight request whose handler hasn't written any bytes yet as inactive. That would break slow responses and quiet server-sent-events streams (SvelteKit's `query.live`, for instance, only sends a keep-alive comment every 30 seconds), so **this adapter defaults `CONNECTION_IDLE_TIMEOUT` to `0`, i.e. no idle timeout**. Set it to a positive number of seconds (up to 255) if you want Bun to reap idle connections; responses with `content-type: text/event-stream` are exempted from it automatically.

This is deliberately _not_ adapter-node's `IDLE_TIMEOUT`, which shuts the whole process down after a period without requests and only has an effect under systemd socket activation. Socket activation is not supported here, so the adapter-node-only variables `IDLE_TIMEOUT`, `KEEP_ALIVE_TIMEOUT`, `HEADERS_TIMEOUT`, `LISTEN_PID` and `LISTEN_FDS` are not part of the supported surface: with an `envPrefix` set, a prefixed one aborts startup with an explanation; without a prefix (where the variable may well belong to another process) the app logs a warning and ignores it.

### Graceful shutdown

On `SIGTERM`/`SIGINT` the server stops accepting new connections and waits up to `SHUTDOWN_TIMEOUT` seconds for in-flight requests to finish before closing the rest forcibly. Once shutdown has completed — gracefully or forced — the app emits `process.emit('sveltekit:shutdown', reason)` with `reason` set to the triggering signal (`'SIGINT'` or `'SIGTERM'`), mirroring `@sveltejs/adapter-node`. Listen for it to clean up resources such as a database connection pool:

```js
process.on('sveltekit:shutdown', async (reason) => {
  await db.close();
});
```

### Origin

The origin used for request URLs and CSRF checks comes from SvelteKit's [`paths.origin`](https://svelte.dev/docs/kit/configuration#paths) and is baked into the binary at build time:

```js
sveltekit({
  adapter: adapter(),
  paths: { origin: 'https://my-site.com' }
});
```

There is no `ORIGIN` environment variable (SvelteKit 3 removed it from the adapter contract). When `paths.origin` is not set, the origin is always derived from the incoming request, corrected by the `PROTOCOL_HEADER`, `HOST_HEADER`, and `PORT_HEADER` environment variables when running behind a reverse proxy. An unconfigured `PROTOCOL_HEADER` (or one absent from a given request) defaults the derived protocol to `https`, since an app without that header configured is assumed to sit behind a TLS-terminating proxy rather than to be served over plain `http`.

A malformed or ambiguous proxy header — a `PROTOCOL_HEADER` value containing `:`, a non-numeric `PORT_HEADER` value, or a comma-joined value for any of `PROTOCOL_HEADER`/`HOST_HEADER`/`PORT_HEADER` (each expects exactly one value; Bun already joins a repeated header with `, `) — fails the request with `400 Bad Request` and logs `Could not determine request origin: …` to stderr, rather than falling through to a generic `500`.

### Server instrumentation

[Server instrumentation](https://svelte.dev/docs/kit/observability) is supported: add `src/instrumentation.server.js` and it is loaded before any application code, in both `compile: true` and `compile: false` mode.

```js
// src/instrumentation.server.js
import { NodeSDK } from '@opentelemetry/sdk-node';

new NodeSDK({/* ... */}).start();
```

To make it work, the adapter turns the generated `build/entry.js` into a small facade — it imports SvelteKit's environment initializer (so `$app/env/private` is already populated from `process.env`), then the instrumentation module, and then `await import`s `build/start.js` (the real entry point), which is what `builder.instrument()` produces. Both graphs are compiled into the executable, so the instrumentation code and its dependencies ship inside the binary.

Two Bun-specific caveats:

- Native (N-API) addons still cannot be embedded, which rules out OpenTelemetry exporters that depend on them in `compile: true` mode.
- Because everything is bundled into one executable, instrumentation that relies on patching the module loader at runtime (OTEL "auto-instrumentation") generally cannot intercept the app's imports. Prefer explicitly configured instrumentations.

### Static assets and response headers

Embedded assets are served with the same semantics as `@sveltejs/adapter-node`:

- `content-type` comes from SvelteKit's MIME metadata (`builder.mimeTypes`, recorded at build time), so types SvelteKit knows about are used rather than only Bun's extension mapping; `text/html` gains `;charset=utf-8`.
- Hashed client build output under `/{appPath}/immutable/` is served with `cache-control: public,max-age=31536000,immutable`. Other assets (e.g. `_app/version.json`, files from `static/`) are not.
- Every static response carries an `ETag` (sha256/base64url hash of the file contents, computed at build time). A matching `If-None-Match` (exact, weak `W/"..."`, or `*`) returns `304 Not Modified` with only the `etag` and `cache-control` headers.
- When `precompress` produced a gzip/brotli variant for an asset (see [Precompression](#precompression)), the response negotiates `Accept-Encoding` (brotli preferred over gzip, `q` values honored, `*` as a fallback weight): a chosen variant is served with `content-encoding: gzip`/`br`, its own size, and an etag suffixed `.gz`/`.br`; the response also carries `Vary: Accept-Encoding`. Range and conditional (`If-None-Match`/`If-Range`) requests apply to whichever representation — raw or variant — was negotiated.
- `Range` requests are supported: `bytes=start-end`, an open-ended `bytes=start-`, and a suffix `bytes=-N` are all honored; an `end` past the end of the file is clamped to `size - 1` rather than rejected; a `Range` with neither bound (`bytes=-`) is ignored and falls through to a full response; `start >= size` or `start > end` returns `416 Range Not Satisfiable` with `content-range: bytes */size`. `If-Range` is honored — the range is only served when `If-Range` is absent or matches the current `ETag`; otherwise the full current representation is returned.
- Every method other than `GET`/`HEAD` — including `OPTIONS` — gets `405 Method Not Allowed` with `allow: GET, HEAD`.
- Dotfiles under `static/` (any path segment starting with `.`) are not embedded in the executable or served, except under `.well-known/`.
- A `.html` file in `static/` gets clean-URL aliases: `/foo` and `/foo/` resolve to `foo.html`, or to `foo/index.html` when only that exists. An exact file always wins over an alias, and when both `foo.html` and `foo/index.html` exist, `foo.html` claims the aliases.
- Trailing-slash redirects for prerendered pages use a **relative** `location` (e.g. `../about`), so they keep working behind a proxy that strips a mount prefix. The query string is preserved.
- Responses whose `content-type` is exactly `text/event-stream` get `x-accel-buffering: no`, which stops nginx-style proxies from buffering server-sent events.

### Windows executable icon and metadata

Set `windows` to embed an icon and version metadata (product title, publisher, version, description, copyright) in the compiled Windows executable, mirroring `Bun.build`'s `compile.windows` shape:

```js
adapter({
  targets: ['bun-windows-x64'],
  windows: {
    icon: 'build-assets/app.ico',
    title: 'My App',
    publisher: 'Acme Inc.',
    version: '1.2.3.4',
    description: 'My SvelteKit app',
    copyright: '© 2026 Acme Inc.',
    hideConsole: true
  }
});
```

**Building natively on Windows:** these fields are passed straight through to Bun's own `compile.windows`.

**Cross-compiling a `bun-windows-*` target from macOS/Linux** (this adapter's main real-world use case): Bun itself silently ignores `compile.windows` here — its icon/metadata embedding depends on Windows APIs (see [Bun's docs](https://bun.sh/docs/bundler/executables#windows-specific-flags)). Rather than ship a binary that silently lacks the requested branding, the adapter post-processes the compiled `.exe`'s PE resources directly (icon, version info, and the console-window subsystem flag for `hideConsole`) using [`resedit`](https://github.com/jet2jet/resedit-js).

This has been verified structurally against real `bun build --compile --target=bun-windows-x64` output — the resource content, section table layout, PE checksum, and Bun's own embedded-asset payload were all confirmed intact apart from the intended edits — but the result has not been executed on Windows as part of that verification (no Windows/Wine available in this environment). **Confirm the executable actually launches on Windows before shipping it to production.**

## Contributing

The test suite runs under [Vitest](https://vitest.dev), **not** `bun test` — the unit
specs use `vi.stubGlobal`, `vi.mock` and `vi.mocked`, which Bun's built-in test runner
does not implement (a stray `bun test` fails immediately with a pointer to the right
command).

```sh
bun install
bun run check            # tsc
bun run test             # everything
bun run test:unit        # tests/*.spec.ts — pure specs, no app builds (~1s)
bun run test:integration # tests/integration/*.spec.ts — builds and runs real apps
bun run test:watch
```

The integration specs build `tests/fixtures/basic-app` (a SvelteKit 3 app) in several
shapes — compiled single-file executable, `compile: false`, with `paths.origin`, with
`paths.base`, with `envPrefix`, with a server instrumentation file — start the result
and assert over real HTTP. They share the fixture directory, so spec files never run in
parallel (see `vitest.config.ts`).

Because `bun install` materializes the fixture's `svelte-kit-bun` dependency as
hardlinks, editing an adapter source file breaks the link and the fixture would build
against a stale copy. The helper detects this and tells you to run
`rm -rf node_modules/.bun/svelte-kit-bun@root && bun install`.

CI (`.github/workflows/test.yml`) runs the typecheck plus both projects on the pinned Bun
version the suite is verified against and on `latest`, so upstream drift is visible
without breaking the pinned job.

## License

[MIT](LICENSE)
