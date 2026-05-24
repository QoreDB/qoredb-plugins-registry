# qoredb-plugins-registry

Canonical source of truth for plugins available on the **QoreDB marketplace**.

This repo is the bytes-and-manifests side of the marketplace:

- The **catalog** lives in `index.json` (machine-readable, schema in `schema/registry-entry.schema.json`).
- Each plugin version lives under `plugins/<plugin-id>/<version>/` and ships a `plugin.json`, a `plugin.zip` (manifest + `.wasm` bundled at the archive root), and a `plugin.zip.sha256` file.
- The QoreDB marketing site at `https://qoredb.com` reads this repo to power its `/marketplace` pages and the in-app **Marketplace** tab.

The submission side (form + admin review queue) lives in `qoredb-showcase` and uses Sanity for the pending state. Once an admin approves a submission, it lands here.

## Layout

```
qoredb-plugins-registry/
├── README.md
├── index.json                            # The catalog
├── schema/
│   └── registry-entry.schema.json        # JSON Schema for index.json
├── scripts/
│   └── build-index.mjs                   # Regenerate index.json from the manifests
└── plugins/
    └── <plugin-id>/                      # e.g. qoredb.danger-guard
        └── <version>/                    # e.g. 1.0.0
            ├── plugin.json               # Verbatim copy of the plugin's manifest
            ├── plugin.zip                # The archive QoreDB downloads to install
            ├── plugin.zip.sha256         # sha256 of plugin.zip (sha256-<64 hex>)
            └── <entry>.wasm              # Mirrored next to the archive, for direct inspection
```

## What's in a `plugin.zip`

The archive contains exactly the files the QoreDB host needs to install the plugin:

- `plugin.json` at the archive root.
- The WASM module file (whatever `runtime.entry` names in the manifest) at the archive root.

Nothing else: no Cargo metadata, no `src/`, no build artefacts. The host runs an install-time budget check (8 MiB total, 256 files max) — keeping archives lean is the contract.

The archive is **flat**: unzipping it produces a folder of files, not a wrapper directory. QoreDB's `install_plugin` reads `plugin.json` from the top of the staging folder.

## Two flavours of plugin

This is enforced by the QoreDB host (`src-tauri/src/plugins/manifest.rs`); the registry mirrors the same shape:

| Flavour | Manifest shape | What it contributes |
| --- | --- | --- |
| **Declarative** | No `runtime` block | Snippets, connection templates, themes, result-viewer mappings — pure data, no code runs. |
| **Executable** | A `runtime` block | The above, plus a sandboxed WASM module that hooks the query lifecycle (`preExecute`, `postExecute`) and/or contributes user-invocable `command`s. |

Every executable plugin should ship `runtime.integrity` (a `sha256-<64 hex>` digest of the WASM bytes). The host refuses to load a module whose digest doesn't match — a tampered or swapped binary fails fast. Unsigned plugins are still allowed, but the QoreDB UI flags them.

## How to add a plugin

Submitting is a public-facing flow handled by `https://qoredb.com/marketplace/submit`. The form drops your archive into the admin review queue (a Sanity document); on approval, the maintainers run `scripts/build-index.mjs` and commit the new version under `plugins/<id>/<version>/`.

Direct PRs against this repo are also welcome for plugins the maintainers prefer to track in git. The structure of a contribution:

1. Compute the manifest `runtime.integrity` against your final `.wasm` (the `qoredb-plugin build` CLI does this for you).
2. Place the manifest + WASM under `plugins/<plugin-id>/<version>/` (`<plugin-id>` must match `plugin.json#id`).
3. Run `node scripts/build-index.mjs` to repackage `plugin.zip`, recompute `plugin.zip.sha256`, and rebuild `index.json`.
4. Open a PR. CI replays steps 2–3 in a clean checkout and fails if anything drifts.

## What the index entries mean

The fields in `index.json` are a verbatim reflection of the upstream `plugin.json`, plus the archive metadata QoreDB needs to download safely. Every detail listed there is independently verifiable:

- `runtime.capabilities` — derived from the manifest's `runtime.capabilities` block (any of `log`, `notify`, `storage`, `queryRead`, `http`, `fs`, `secrets`). Surfaced as badges on the marketplace UI so users know what consent will be asked.
- `runtime.hooks` — `preExecute` / `postExecute` exactly as declared.
- `runtime.integrity` — copied through; absent for unsigned plugins.
- `archive.sha256` — sha256 of `plugin.zip` itself, not of the WASM inside. Verified by QoreDB end-to-end *before* the manifest is parsed, so a hostile archive never reaches the manifest validator.
- `contributes.commands` — bare command ids; what the user clicks in the UI.

`registryVersion: 1` is the wire-compat number. Any change to the index shape that breaks current QoreDB clients bumps it.

## Compatibility

Every plugin in this registry targets QoreDB **`>=0.1.29`** (the version that shipped the executable plugin runtime and consent UI). The QoreDB host's `qoredb` field check is best-effort: an unparseable requirement is treated as compatible so a typo doesn't silently disable a plugin.

## License

This repo's *infrastructure* (scripts, schemas, tooling) is Apache-2.0. Each plugin under `plugins/` carries its own license — see the plugin's own `README` or `LICENSE` once shipped alongside the archive.
