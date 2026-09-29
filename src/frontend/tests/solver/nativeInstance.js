// --native: the decoder and router modules run as native code instead of
// WebAssembly (tests/solver/native, npm run build:native), about 1.6x faster
// on the anneal and the same walks on the boards measured (2026-09-26). The
// app keeps WebAssembly: anything that must match the editor, like the
// release benchmark, runs without this flag.
const path = require("path");

const BUILD = path.join(__dirname, "native", "build");

/** From now on, instantiating these modules gives their native builds. */
function install(decodeModule, routeModule) {
  const addon = require(path.join(BUILD, "v5native.node"));
  const libs = new Map([[decodeModule, path.join(BUILD, "libv5decode.so")], [routeModule, path.join(BUILD, "libv5route.so")]]);
  const Instance = WebAssembly.Instance;
  WebAssembly.Instance = function (module, imports) {
    const lib = libs.get(module);
    return lib ? addon.instantiate(lib, imports ?? {}) : new Instance(module, imports);
  };
}

module.exports = { install };
