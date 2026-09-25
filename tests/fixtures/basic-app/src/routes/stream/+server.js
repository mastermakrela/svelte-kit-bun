/**
 * Server-sent events. `?gap=<ms>` controls how long the stream stays quiet
 * between messages and `?ticks=<n>` how many messages it sends, so tests can
 * exercise a connection that idles for longer than `CONNECTION_IDLE_TIMEOUT`.
 */
export const GET = ({ url }) => {
	const gap = Number(url.searchParams.get('gap') ?? '150');
	const ticks = Number(url.searchParams.get('ticks') ?? '3');

	let i = 0;
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const timer = setInterval(() => {
				controller.enqueue(encoder.encode(`data: tick ${i++}\n\n`));
				if (i >= ticks) {
					clearInterval(timer);
					controller.close();
				}
			}, gap);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	});
};
