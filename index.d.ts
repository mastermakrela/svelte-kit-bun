import { Adapter } from "@sveltejs/kit";
import "./ambient.js";

export default function plugin(options?: AdapterOptions): Adapter;

export interface AdapterOptions {
	// TODO: add bun specific options
}
