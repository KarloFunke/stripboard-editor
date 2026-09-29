// Native stand-in for the v5 WebAssembly modules, for the solver harness
// only (the app keeps WebAssembly). decode.c and route.c build natively as
// shared libraries; instantiate() loads a private copy of one (the C code
// keeps its state in globals, and a solve runs two decoders at once), hands
// it a fixed arena and returns what V5WasmDecoder and RouteWasm expect from
// a WebAssembly instance: the exported functions, with addresses as offsets
// into the arena, and memory.buffer over that arena.
//
// Build: npm run build:native. Use: tests/solver/nativeInstance.js.
#define NAPI_VERSION 8
#include <node_api.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define ARENA_BYTES (2ull << 30)

typedef struct {
  void *lib;
  unsigned char *arena;
  napi_env env;
  napi_ref report, movelog;
} Inst;

// the export's C function and its instance
typedef struct { Inst *in; void *fn; } Fn;

#define CHECK(x) do { if ((x) != napi_ok) { napi_throw_error(env, NULL, "v5native: " #x); return NULL; } } while (0)

static Inst *instOf(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv, Fn **fnOut) {
  void *data;
  napi_get_cb_info(env, info, argc, argv, NULL, &data);
  Fn *f = data;
  f->in->env = env;
  *fnOut = f;
  return f->in;
}
static double num(napi_env env, napi_value v) { double d = 0; napi_get_value_double(env, v, &d); return d; }
static void *ptr(Inst *in, napi_value v, napi_env env) { return in->arena + (int64_t)num(env, v); }
static napi_value retNum(napi_env env, double d) { napi_value r; napi_create_double(env, d, &r); return r; }
static napi_value retPtr(napi_env env, Inst *in, void *p) { return retNum(env, (double)((unsigned char *)p - in->arena)); }
static napi_value retUndef(napi_env env) { napi_value r; napi_get_undefined(env, &r); return r; }

// one wrapper per signature: v void, i int32, u uint32, d double, p address
#define ARGS(n) size_t argc = n; napi_value argv[n > 0 ? n : 1]; Fn *f; Inst *in = instOf(env, info, &argc, argv, &f); (void)in
static napi_value w_v_(napi_env env, napi_callback_info info) { ARGS(0); ((void (*)(void))f->fn)(); return retUndef(env); }
static napi_value w_i_(napi_env env, napi_callback_info info) { ARGS(0); return retNum(env, ((int32_t (*)(void))f->fn)()); }
static napi_value w_u_(napi_env env, napi_callback_info info) { ARGS(0); return retNum(env, ((uint32_t (*)(void))f->fn)()); }
static napi_value w_d_(napi_env env, napi_callback_info info) { ARGS(0); return retNum(env, ((double (*)(void))f->fn)()); }
static napi_value w_p_(napi_env env, napi_callback_info info) { ARGS(0); return retPtr(env, in, ((void *(*)(void))f->fn)()); }
static napi_value w_p_i(napi_env env, napi_callback_info info) { ARGS(1); return retPtr(env, in, ((void *(*)(int32_t))f->fn)((int32_t)num(env, argv[0]))); }
static napi_value w_p_pp(napi_env env, napi_callback_info info) { ARGS(2); return retPtr(env, in, ((void *(*)(void *, void *))f->fn)(ptr(in, argv[0], env), ptr(in, argv[1], env))); }
static napi_value w_v_i(napi_env env, napi_callback_info info) { ARGS(1); ((void (*)(int32_t))f->fn)((int32_t)num(env, argv[0])); return retUndef(env); }
static napi_value w_v_u(napi_env env, napi_callback_info info) { ARGS(1); ((void (*)(uint32_t))f->fn)((uint32_t)num(env, argv[0])); return retUndef(env); }
static napi_value w_v_d(napi_env env, napi_callback_info info) { ARGS(1); ((void (*)(double))f->fn)(num(env, argv[0])); return retUndef(env); }
static napi_value w_v_ii(napi_env env, napi_callback_info info) { ARGS(2); ((void (*)(int32_t, int32_t))f->fn)((int32_t)num(env, argv[0]), (int32_t)num(env, argv[1])); return retUndef(env); }
static napi_value w_v_iid(napi_env env, napi_callback_info info) {
  ARGS(3); ((void (*)(int32_t, int32_t, double))f->fn)((int32_t)num(env, argv[0]), (int32_t)num(env, argv[1]), num(env, argv[2])); return retUndef(env);
}
// v5_annealStart(u32, u32, double, i32, i32, double, 7 x double, i32, i32)
static napi_value w_anneal(napi_env env, napi_callback_info info) {
  ARGS(15);
  double a[15];
  for (int k = 0; k < 15; k++) a[k] = num(env, argv[k]);
  ((void (*)(uint32_t, uint32_t, double, int32_t, int32_t, double, double, double, double, double, double, double, double, int32_t, int32_t))f->fn)(
    (uint32_t)a[0], (uint32_t)a[1], a[2], (int32_t)a[3], (int32_t)a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], (int32_t)a[13], (int32_t)a[14]);
  return retUndef(env);
}

static void callJs(Inst *in, napi_ref ref, int n, double *vals) {
  if (!ref) return;
  napi_env env = in->env;
  napi_value fn, recv, args[2];
  napi_get_reference_value(env, ref, &fn);
  napi_get_undefined(env, &recv);
  for (int k = 0; k < n; k++) napi_create_double(env, vals[k], &args[k]);
  napi_call_function(env, recv, fn, n, args, NULL);
}
static void cbReport(void *ctx, double f) { callJs(ctx, ((Inst *)ctx)->report, 1, &f); }
static void cbMovelog(void *ctx, int32_t off, int32_t n) { double v[2] = { off, n }; callJs(ctx, ((Inst *)ctx)->movelog, 2, v); }

static const struct { const char *name; napi_callback w; } EXPORTS[] = {
  { "v5_reset", w_v_ }, { "v5_alloc", w_p_i }, { "v5_setExport", w_v_ii }, { "v5_init", w_p_pp }, { "v5_decode", w_i_ },
  { "v5_exportHdr", w_p_ }, { "v5_setMix", w_v_iid }, { "v5_setMixLateFrom", w_v_d }, { "v5_rngSet", w_v_u }, { "v5_rngGet", w_u_ },
  { "v5_rand", w_d_ }, { "v5_setShape", w_v_d }, { "v5_setPullTie", w_v_i }, { "v5_labInit", w_v_ }, { "v5_labMutate", w_i_ }, { "v5_setMoveLog", w_v_i }, { "v5_annealStart", w_anneal },
  { "v5_annealStep", w_i_ },
  { "r_reset", w_v_ }, { "r_alloc", w_p_i }, { "r_route", w_p_pp },
};

static napi_ref importFn(napi_env env, napi_value imports, const char *name) {
  napi_value envObj, fn;
  bool has = false;
  if (napi_has_named_property(env, imports, "env", &has) != napi_ok || !has) return NULL;
  napi_get_named_property(env, imports, "env", &envObj);
  napi_has_named_property(env, envObj, name, &has);
  if (!has) return NULL;
  napi_get_named_property(env, envObj, name, &fn);
  napi_valuetype t;
  napi_typeof(env, fn, &t);
  if (t != napi_function) return NULL;
  napi_ref ref;
  napi_create_reference(env, fn, 1, &ref);
  return ref;
}

// instantiate(libPath, imports) -> { exports }
static napi_value instantiate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char path[4096];
  size_t len;
  CHECK(napi_get_value_string_utf8(env, argv[0], path, sizeof path, &len));
  // a private copy: dlopen of one path shares its globals
  char tmp[] = "/tmp/v5native-XXXXXX";
  int fd = mkstemp(tmp);
  FILE *src = fopen(path, "rb");
  if (fd < 0 || !src) { napi_throw_error(env, NULL, "v5native: cannot copy the library"); return NULL; }
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, src)) > 0) if (write(fd, buf, n) != (ssize_t)n) break;
  fclose(src);
  close(fd);
  void *lib = dlopen(tmp, RTLD_NOW | RTLD_LOCAL);
  unlink(tmp);
  if (!lib) { napi_throw_error(env, NULL, dlerror()); return NULL; }
  Inst *in = calloc(1, sizeof(Inst));
  in->lib = lib;
  in->env = env;
  in->arena = mmap(NULL, ARENA_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (in->arena == MAP_FAILED) { napi_throw_error(env, NULL, "v5native: no arena"); return NULL; }
  ((void (*)(void *, unsigned long long))dlsym(lib, "native_setArena"))(in->arena, ARENA_BYTES);
  void *setCb = dlsym(lib, "native_setCallbacks");
  if (setCb) {
    in->report = importFn(env, argv[1], "report");
    in->movelog = importFn(env, argv[1], "movelog");
    ((void (*)(void *, void (*)(void *, double), void (*)(void *, int32_t, int32_t)))setCb)(in, cbReport, cbMovelog);
  }
  napi_value exports, mem, ab;
  CHECK(napi_create_object(env, &exports));
  for (size_t k = 0; k < sizeof EXPORTS / sizeof EXPORTS[0]; k++) {
    void *fn = dlsym(lib, EXPORTS[k].name);
    if (!fn) continue;
    Fn *f = malloc(sizeof(Fn));
    f->in = in;
    f->fn = fn;
    napi_value jf;
    CHECK(napi_create_function(env, EXPORTS[k].name, NAPI_AUTO_LENGTH, EXPORTS[k].w, f, &jf));
    CHECK(napi_set_named_property(env, exports, EXPORTS[k].name, jf));
  }
  CHECK(napi_create_external_arraybuffer(env, in->arena, ARENA_BYTES, NULL, NULL, &ab));
  CHECK(napi_create_object(env, &mem));
  CHECK(napi_set_named_property(env, mem, "buffer", ab));
  CHECK(napi_set_named_property(env, exports, "memory", mem));
  napi_value res;
  CHECK(napi_create_object(env, &res));
  CHECK(napi_set_named_property(env, res, "exports", exports));
  return res;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "instantiate", NAPI_AUTO_LENGTH, instantiate, NULL, &fn);
  napi_set_named_property(env, exports, "instantiate", fn);
  return exports;
}
