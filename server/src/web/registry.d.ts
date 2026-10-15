/**
 * Every provider file in `providers/`, imported for its `registerWebProvider`
 * call. The build makes this module from the directory (`webProviders` in
 * `desktop/build.mjs`), which is why a new provider is one new file and
 * nothing else. It exports nothing.
 */
declare module "kururu:web-providers" {}
