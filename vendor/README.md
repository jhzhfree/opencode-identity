# Vendored runtime sources

- `identity-lab/`: the 1.1.0 local demonstration runtime from the earlier delivery of this project. Its MIT LICENSE is retained. It replaces the previous hardcoded sibling-directory dependency. AKB production uses its file/ACL helpers, not its local proof protocol.
- `jsonc-parser/`: Microsoft `jsonc-parser` 3.3.1 UMD distribution from npm. `LICENSE.md` and a CommonJS package marker are retained. Used to update OpenCode JSONC without losing comments or unrelated settings. Production clients and request signing do not depend on it.
