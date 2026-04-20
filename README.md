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

## License

[MIT](LICENSE)
