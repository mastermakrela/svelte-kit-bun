import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	// read by `instrumentation.server.js` to prove kit's env initializer populated
	// `$app/env/private` before the instrumentation module was evaluated
	FIXTURE_RUNTIME_SECRET: {
		schema: (value) => value ?? null
	}
});
