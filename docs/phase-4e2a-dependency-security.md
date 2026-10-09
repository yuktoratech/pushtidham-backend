# Phase 4E-2A frontend dependency security hardening

## Baseline

Audit date: 2026-10-09. Frontend used Node 25.3.0 and npm 11.7.0 on `backend-integration`. Backend remained on `main` and was not changed for dependency remediation.

Full `npm audit --json` baseline: **22** findings — 1 critical, 17 high, 4 moderate. The deployable production set included the vulnerable Next.js runtime. Backend audit remained at zero.

Key baseline paths:

- `next@16.3.4`: GHSA-vcvr-r3jv-pc5j (critical RCE in `next/og`), GHSA-cjq9-62q9-8jv4 (high SSRF), and five moderate/low cache, metadata, and development-server advisories. Affected ranges ended at 16.3.6 or 16.3.8.
- `react-server-dom-webpack@19.2.6`: GHSA-wx67-qw84-cm4g (high denial of service), fixed in the 19.2 line at 19.2.8.
- `vite@8.0.13`: GHSA-fx2h-pf6j-xcff and GHSA-v6wh-96g9-6wx3, fixed at 8.0.16.
- Cloudflare/Vinext development and deployment tooling pulled vulnerable `miniflare`, `undici`, `ws`, `sharp`, `image-size`, `fast-glob`, `micromatch`, and `braces` paths.

## Applied compatible changes

| Package | Before | After | Reason |
| --- | ---: | ---: | --- |
| `next` | 16.3.4 | 16.3.8 | Smallest same-minor release outside all reported Next affected ranges |
| `eslint-config-next` | 16.3.4 | 16.3.8 | Keep framework lint tooling aligned |
| `react` / `react-dom` | 19.2.6 | 19.2.8 | Keep RSC peer versions aligned on the same patch line |
| `react-server-dom-webpack` | 19.2.6 | 19.2.8 | Fix GHSA-wx67-qw84-cm4g |
| `vite` | 8.0.13 | 8.0.16 | Fix the reported Vite high/moderate ranges |
| `vinext` | 1.0.0-beta.5 | 1.1.0 | Stable compatible tooling release; removes vulnerable `image-size` path |
| `@vitejs/plugin-rsc` | 0.5.26 | 0.5.34 | Satisfy Vinext 1.1 peer contract |
| Miniflare `sharp` override | 0.35.4 | 0.35.5 | Fix GHSA-wq5f-xc86-pv6w |

No application, checkout, authentication, styling, or backend implementation file changed.

## Final audit and remaining risk

- Full dependency set: **20** findings — 0 critical, 10 high, 10 moderate.
- Production dependencies (`npm audit --omit=dev --json`): **0** findings.
- Backend: **0** findings.

Remaining high findings are development/build/deployment-tool paths:

- GHSA-vfj7-8cjw-p6xm in `braces@3.0.3`, propagated through `micromatch`/`fast-glob` into `eslint-config-next` and Vinext tooling. npm publishes no patched `braces` release; its proposed fix downgrades `eslint-config-next` to 14.2.35, an incompatible framework-major change.
- Undici advisories 1121187, 1121244, 1121247, 1130718, 1240041, and 1240050 (plus related moderate/low advisories) and ws advisories 1119108/1123259 are pulled by the pinned Cloudflare/Miniflare toolchain.
- `vite-plugin-commonjs` and `vite-plugin-dynamic-import` propagate the `fast-glob` path under Vinext. npm's proposed resolution is the incompatible Vinext downgrade to 0.2.1.

Moderate findings remain in Cloudflare/Miniflare, Drizzle Kit's legacy esbuild loader, and Vinext's `@vercel/og`/Satori/fflate path. npm's proposed Drizzle fix is a downgrade to 0.18.1; the Vinext proposal is a downgrade to 0.2.1. Neither was applied automatically.

The first non-vulnerable Cloudflare plugin path checked was `@cloudflare/vite-plugin@1.51.1` with Wrangler 4.120.0. It requires `@cloudflare/workers-types` major 5 while this project pins major 4. The newest plugin 1.63.1 has the same major-5 requirement. Installation correctly failed with `ERESOLVE`; no `--force`, legacy-peer bypass, or blanket override was used.

Because applicable high-severity development/deployment findings remain, the **overall Phase 4E-2A security gate is BLOCKED**, despite the deployable Next.js production dependency set being clean.

## Compatibility verification

- Frontend lint: passed with 0 errors and the existing 12 `no-img-element` warnings.
- Frontend TypeScript: passed.
- Frontend contract tests: 19 passed, 0 failed, 0 skipped.
- Frontend production build: passed on Next.js 16.3.8.
- Real Chrome Playwright: 9 passed at 320, 375, 390, 430, 768, 1024, and 1440 px.
- Backend: lint, typecheck, build, and 52 isolated replica-set tests passed; audit reports zero vulnerabilities.

Payment and authentication contracts remained intact: hosted Stripe/ACH initiation, PayPal SDK v6 eligibility and conditional Venmo, server-owned totals, idempotency, guest grants, return/capture guards, backend-authoritative confirmation, fee opt-in default, and legacy bank transfer behavior.

## Phase 4E-2B prerequisite

Before real-provider sandbox work, choose and validate one controlled tooling path: approve the Cloudflare workers-types v5 migration and retest deployment tooling; remove unused deployment tooling only after proving it is unnecessary; or wait for compatible upstream releases. Re-run full and production-only audits plus all frontend/browser/backend checks after that decision.
