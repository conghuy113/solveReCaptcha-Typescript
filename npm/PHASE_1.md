# Phase 1 — Transitional worker bridge (historical)

## Outcome

The npm package established the stable consumer contract:

```ts
solveReCaptcha(options): Promise<SolveReCaptchaResult>
```

`targetUrl`, `port`, and `clickCheckbox` are required. Chrome must already be
running with remote debugging; the library does not launch or close it.

The first implementation delegated through a versioned JSON-lines protocol to
a frozen platform worker selected from an optional dependency. It established
the npm contract while the implementation was migrated.

## Final status

The bridge, worker protocol, Python runtime, native build scripts, and optional
platform packages have been removed. `solveReCaptcha()` now executes entirely
through the TypeScript modules documented in [Phase 3](./PHASE_3.md). Model
delivery remains the verified, shared flow described in [Phase 2](./PHASE_2.md).
