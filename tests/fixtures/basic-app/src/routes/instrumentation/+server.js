import { json } from '@sveltejs/kit';

export function GET() {
	return json({
		order: globalThis.__adapter_bun_load_order ?? [],
		marker: globalThis.__adapter_bun_instrumentation_marker ?? null
	});
}
