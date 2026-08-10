/** Echoes the origin SvelteKit resolved for the request, so tests can assert on it. */
export const GET = ({ url }) =>
	new Response(url.origin, { headers: { 'content-type': 'text/plain' } });
