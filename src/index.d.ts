import type { SSRManifest, Server } from "@sveltejs/kit";
import "../ambient";

interface Prerendered {
	assets: [string, { type: string }][];
	redirects: [string, { status: number; location: string }][];
	pages: [string, { file: string }][];
}

export { Server, Prerendered };
