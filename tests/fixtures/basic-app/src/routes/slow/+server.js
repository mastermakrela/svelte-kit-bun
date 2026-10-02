/**
 * A handler that writes nothing for `?delay=<ms>` (capped) before responding.
 * Bun.serve's idle timer counts such a request as idle, so this is how the test
 * suite checks that the adapter's default doesn't cut quiet responses short.
 */
export const GET = async ({ url }) => {
	const delay = Math.min(30_000, Number(url.searchParams.get('delay') ?? '0'));
	await new Promise((resolve) => setTimeout(resolve, delay));

	return new Response(`slept ${delay}ms`, {
		headers: { 'content-type': 'text/plain' }
	});
};
