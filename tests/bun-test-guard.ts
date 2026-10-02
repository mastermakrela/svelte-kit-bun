/**
 * Preloaded by `bun test` via `bunfig.toml`. The suite is a Vitest suite (the unit
 * specs need `vi.stubGlobal`, `vi.mock` and `vi.mocked`, which Bun's runner lacks),
 * so fail immediately with a pointer instead of letting Bun run the specs and report
 * a wall of unrelated failures.
 */
throw new Error(
	'`bun test` cannot run this suite — it uses Vitest APIs (vi.stubGlobal, vi.mock, vi.mocked).\n' +
		'Use `bun run test` (all specs), `bun run test:unit` or `bun run test:integration` instead.'
);
