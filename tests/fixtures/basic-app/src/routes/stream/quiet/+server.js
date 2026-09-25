// Stays silent for longer than the IDLE_TIMEOUT the executable tests run with,
// so it only completes if the runtime exempts server-sent events from it.
export const GET = () => {
	const stream = new ReadableStream({
		start(controller) {
			setTimeout(() => {
				controller.enqueue(new TextEncoder().encode('data: late\n\n'));
				controller.close();
			}, 2500);
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	});
};
