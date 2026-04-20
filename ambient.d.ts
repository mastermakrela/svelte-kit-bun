declare global {
	namespace App {
		export interface Platform {
			/**
			 * The Bun server instance handling the request.
			 */
			server: import('bun').Server<unknown>;
		}
	}
}

export {};
