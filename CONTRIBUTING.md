# Contributing

This is a small, evidence-first teaching project. Bug reports and focused pull requests are welcome. Read the README support status and limitations before proposing work.

## Before you start

- Run `npm ci && npm test`, then `node scripts/verify.mjs`. Include the failing stage and the exact output.
- For browser problems, state the browser, version, operating system and viewport, and whether `node scripts/e2e-web.mjs` also fails.
- Do not paste secrets, private datasets, credentials, or personal file paths into an issue.
- Search existing issues and pull requests before opening a duplicate, and use synthetic or fully sanitized inputs.

## Development setup

Supported version: **0.1.0-a1** with Node.js >= 22.18.0. Python 3 with NumPy is required only for the independent reference tests.

```sh
npm install
npm test
python scripts/check_docs.py
```

When behavior changes, add a failing test first and show it failing before the fix. If an optional browser or integration environment is unavailable, report the exact skip or failure instead of claiming it passed.

## Pull requests

- Keep the frozen numerical contract in `docs/NUMERICAL_CONTRACT.md` unchanged unless the pull request is explicitly about a contract revision.
- Add positive and negative controls for numerical, cache, fault-injection, paging, or output-publication changes.
- Run `npm test`, `node scripts/verify.mjs`, and `node scripts/e2e-web.mjs`. Report any stage you could not run.
- The web lab stays static and offline: no runtime dependencies, web fonts, CDNs, analytics, or external APIs.
- Preserve CLI/API/report semantics unless the contract is explicitly revised with tests and documentation.
- Do not invent benchmarks, users, adoption, release URLs, or compatibility results.
- By contributing, you agree that your contribution is licensed under the MIT License.

## Reporting issues

Use the bug or feature template. Include Node/Python and OS versions, package version or commit, the exact command, minimal sanitized input, expected and actual results, and whether the issue reproduces from an installed package. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
