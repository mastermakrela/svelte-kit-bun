export const prerender = false;

export function load() {
	return {
		time: new Date().toISOString()
	};
}
