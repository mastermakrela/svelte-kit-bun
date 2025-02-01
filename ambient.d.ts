import { Server as BunServer } from "bun";

declare global {
	namespace App {
		export interface Platform {
			server: BunServer;
		}
	}
}
