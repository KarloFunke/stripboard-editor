// The layouter's two WebAssembly modules in the browser (the decoder and the
// wire router, built from decode.c and route.c): fetched beside this file,
// compiled once per worker or page. The harness loads them from disk.
import { setRouteWasm } from "./routeWasm";

let decoder: Promise<WebAssembly.Module> | undefined;
export const loadDecoderWasm = (): Promise<WebAssembly.Module> =>
  (decoder ??= WebAssembly.compileStreaming(fetch(new URL("./v5decode.wasm", import.meta.url))));

let router: Promise<void> | undefined;
export const loadRouterWasm = (): Promise<void> =>
  (router ??= WebAssembly.compileStreaming(fetch(new URL("./v5route.wasm", import.meta.url))).then(setRouteWasm));
