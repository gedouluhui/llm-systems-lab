# Contributing

This is a small, evidence-first teaching project. Bug reports and focused pull requests are welcome.

## Before opening an issue

- Run `npm ci && npm test`, then `node scripts/verify.mjs`. Include the failing stage and the exact output.
- For browser problems, state the browser, version, operating system and viewport, and whether `node scripts/e2e-web.mjs` also fails.
- Do not paste secrets, private datasets, credentials, or personal file paths into an issue.

## Pull requests

- Keep the frozen numerical contract in `docs/NUMERICAL_CONTRACT.md` unchanged unless the pull request is explicitly about a contract revision.
- When behavior changes, add a failing test first and show it failing before the fix.
- Run `npm test`, `node scripts/verify.mjs`, and `node scripts/e2e-web.mjs`. Report any stage you could not run instead of claiming it passed.
- The web lab stays static and offline: no runtime dependencies, web fonts, CDNs, analytics, or external APIs.
- By contributing, you agree that your contribution is licensed under the MIT License.
