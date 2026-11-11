/*
 * One window property Electron does not reach: NSWindow's `canHide`.
 *
 * Hiding an application (⌘H, the Dock, or another app's
 * `NSRunningApplication.hide`, which is how a workspace switcher puts away
 * every app that is not in the workspace) takes down every window it has
 * whose `canHide` is YES, which is all of them unless somebody says
 * otherwise. The floating Kuru and the pill are meant to be over every app
 * whatever is in front, so their windows say otherwise, and the window and
 * the notes still go with the app. Electron sets the property for none of
 * its own options and offers no setter, so this is the setter.
 *
 * A Node-API addon rather than a helper process: the property belongs to a
 * window in this process, and nothing outside it can set it. Node-API's few
 * declarations are written out below rather than taken from `node_api.h`,
 * because that header is not in the repository or on a fresh CI runner, and
 * the ABI is the one Node promises never to break: the functions are found
 * at load in whichever binary loads this, the app's or Node's
 * (`-undefined dynamic_lookup`).
 */
#import <AppKit/AppKit.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern napi_status napi_get_buffer_info(napi_env, napi_value, void **, size_t *);
extern napi_status napi_get_value_bool(napi_env, napi_value, bool *);
extern napi_status napi_get_boolean(napi_env, bool, napi_value *);
extern napi_status napi_create_object(napi_env, napi_value *);
extern napi_status napi_create_int64(napi_env, int64_t, napi_value *);
extern napi_status napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern napi_status napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern napi_status napi_get_undefined(napi_env, napi_value *);

/**
 * The window behind `BrowserWindow.getNativeWindowHandle()`, which on a Mac
 * is a buffer holding the content view's pointer. Main's JavaScript runs on
 * the main thread, so AppKit may be touched from here.
 */
static NSWindow *windowOf(napi_env env, napi_value buffer) {
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, buffer, &data, &length) != 0 || length < sizeof(void *) || !data) return nil;
  NSView *view = (__bridge NSView *)(*(void **)data);
  if (![view isKindOfClass:[NSView class]]) return nil;
  return [view window];
}

/** `stays(handle, yes)`: whether the window stays up while its app is hidden. True if it was set. */
static napi_value Stays(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow *window = argc >= 1 ? windowOf(env, argv[0]) : nil;
  bool stays = true;
  if (argc >= 2) napi_get_value_bool(env, argv[1], &stays);
  if (window) [window setCanHide:!stays];
  napi_get_boolean(env, window != nil, &result);
  return result;
}

/** `read(handle)`: what AppKit says about the window, for a test to check. */
static napi_value Read(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow *window = argc >= 1 ? windowOf(env, argv[0]) : nil;
  if (!window) {
    napi_get_undefined(env, &result);
    return result;
  }
  napi_value value;
  napi_create_object(env, &result);
  napi_get_boolean(env, [window canHide], &value);
  napi_set_named_property(env, result, "canHide", value);
  napi_get_boolean(env, [window isVisible], &value);
  napi_set_named_property(env, result, "visible", value);
  napi_get_boolean(env, [window isKeyWindow], &value);
  napi_set_named_property(env, result, "key", value);
  napi_get_boolean(env, [NSApp isHidden], &value);
  napi_set_named_property(env, result, "appHidden", value);
  napi_get_boolean(env, [NSApp isActive], &value);
  napi_set_named_property(env, result, "appActive", value);
  napi_create_int64(env, (int64_t)[window level], &value);
  napi_set_named_property(env, result, "level", value);
  napi_create_int64(env, (int64_t)[window collectionBehavior], &value);
  napi_set_named_property(env, result, "behavior", value);
  napi_create_int64(env, (int64_t)[window styleMask], &value);
  napi_set_named_property(env, result, "style", value);
  return result;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "stays", (size_t)-1, Stays, NULL, &fn);
  napi_set_named_property(env, exports, "stays", fn);
  napi_create_function(env, "read", (size_t)-1, Read, NULL, &fn);
  napi_set_named_property(env, exports, "read", fn);
  return exports;
}
