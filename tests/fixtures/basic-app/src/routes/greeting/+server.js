import { read } from '$app/server';
import greetingAsset from '$lib/greeting.txt';

export const GET = () =>
	new Response(read(greetingAsset).body, {
		headers: { 'content-type': 'text/plain' }
	});
