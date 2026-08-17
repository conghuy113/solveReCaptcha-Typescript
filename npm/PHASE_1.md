# Phase 1 — Transitional worker bridge

## Outcome

The npm package established the stable consumer contract:

```ts
solveReCaptcha(options): Promise<SolveReCaptchaResult>
```

`targetUrl`, `port`, and `clickCheckbox` are required. Chrome must already be
running with remote debugging; the library does not launch or close it.

The first implementation delegates through a versioned JSON-lines protocol to
a frozen platform worker selected from an optional dependency. This bridge
lets consumers use npm without installing Python, but it is not the final
architecture.

## Current status

The bridge remains the runtime behind `solveReCaptcha()` while the solver is
ported incrementally. Platform packages must not bundle model files: models
are delivered once from a hash-pinned GitHub Release into the shared cache as
described in [Phase 2](./PHASE_2.md).

Platform-worker publication and rebuild work is maintenance-only. The intended
end state is a single TypeScript package with no worker selection or Python
runtime.
