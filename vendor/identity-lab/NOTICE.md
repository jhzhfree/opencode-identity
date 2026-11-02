# NOTICE — vendored `identity-lab` runtime

`vendor/identity-lab/` is a **copy** of the upstream `mcp-agent-identity-lab`
package (release 1.1.0), which accompanies the OpenCode Identity tool kit.

Why it is vendored here:

- The plugin generator (`lib/generator.mjs`) and the protected-file helpers
  (`lib/files.mjs`, `lib/protection.mjs`) are part of how this repository produces
  plugins. They used to be resolved from a sibling `1.1.0/…` directory *outside*
  the repository, which meant the app could not be moved, cloned or shipped on
  its own.
- Files kept in sync with upstream: `generator.mjs`, `files.mjs`, `protection.mjs`,
  `proof.mjs`, `client.mjs`, `server.mjs`, `opencode-compat.mjs`,
  `opencode-plugin.mjs` (1.x template), `opencode-plugin-v2.mjs` (2.x template),
  `bin/lab.mjs`.

What is **not** vendored from upstream:

- The cryptographic implementation. `proof.mjs` / `client.mjs` / `server.mjs` in
  this repository's own code paths are provided by `@opencode-identity/sdk`
  (`packages/identity-sdk`); the vendored copies exist only because the upstream
  generator imports them internally.
- `node_modules/` and test fixtures.

Runtime dependencies of the *generated 1.x plugin template* — `@opencode-ai/plugin`
and `effect` — are declared as optional peer dependencies: the host OpenCode
installation provides them. The 2.x template has no third-party imports.

If upstream publishes a newer release, replace the files in `lib/` and `bin/`
wholesale and re-run `npm test` from the repository root.
