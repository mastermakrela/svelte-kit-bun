import sampleMd from '$lib/sample.md?raw';

export const prerender = false;

export function load() {
	return { sampleMd };
}
