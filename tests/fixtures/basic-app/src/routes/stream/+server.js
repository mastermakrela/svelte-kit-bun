export const GET = () => {
	let i = 0;
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const timer = setInterval(() => {
				controller.enqueue(encoder.encode(`data: tick ${i++}\n\n`));
				if (i >= 3) {
					clearInterval(timer);
					controller.close();
				}
			}, 150);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	});
};
