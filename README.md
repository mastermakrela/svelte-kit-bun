# @sveltejs/adapter-bun

**Experimental.** Adapter for SvelteKit apps that compiles the app into a [Bun single-file executable](https://bun.com/docs/bundler/executables). All static, prerendered, and server assets are embedded into the binary — the resulting file runs standalone with no external dependencies.

## Requirements

- [Bun](https://bun.com/) >= 1.2.17 — the build and the resulting binary both run under Bun.
- SvelteKit >= 2.4.0.

## Caveats

- **No native (N-API) modules in single-file mode.** Packages that ship `.node` addons (`sharp`, `better-sqlite3`, `argon2`, `canvas`, etc.) cannot be embedded in the executable. WASM works. Native addons _do_ work if you set `compile: false`.
- **Read-only filesystem (single-file mode).** Embedded assets live in Bun's `$bunfs`, which is read-only. Persist any user data outside the binary.
- **Not yet supported:** service worker embedding, instrumentation hooks, socket activation.

## Usage

```js
// svelte.config.js
import adapter from '@sveltejs/adapter-bun';

export default {
  kit: {
    adapter: adapter()
  }
};
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

## License

[MIT](LICENSE)
