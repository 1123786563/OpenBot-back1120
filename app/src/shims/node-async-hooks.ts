/**
 * The browser's answer to `node:async_hooks`: there is none.
 *
 * `identity.ts` binds a mutation's lifecycle callbacks to the identity they started under, and the
 * exact binding needs an async context — the engine feature that follows a callback across its own
 * `await`s. Node and Bun have one (`AsyncLocalStorage`); a browser does not. The module imports the
 * class from `node:async_hooks`, and this shim is what the browser build resolves that specifier to
 * (app/vite.config.ts): an `AsyncLocalStorage` of `undefined`, which `identity.ts` reads as "the
 * engine offers no async context" and answers with its documented fallback. Under Bun — the tests —
 * the real class is imported and the exact path runs.
 */
export const AsyncLocalStorage = undefined as never;
