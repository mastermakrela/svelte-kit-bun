import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

export const prerender = true;

export function load() {
	redirect(308, resolve('/about'));
}
