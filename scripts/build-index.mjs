#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regenerates `plugin.zip`, `plugin.zip.sha256` and the top-level
// `index.json` from the on-disk `plugin.json` manifests.
//
// Run from the repo root:
//   node scripts/build-index.mjs
//
// What it does for every `plugins/<id>/<version>/` directory:
//   1. Re-zips `plugin.json` + the WASM module declared by `runtime.entry`
//      (only those two files — the host's install budget is 8 MiB / 256 files
//      and unnecessary payload would tip declarative plugins over).
//   2. Computes the sha256 of the new archive and writes it to
//      `plugin.zip.sha256` in `sha256-<64 hex>` form.
//   3. Builds an entry shaped like `schema/registry-entry.schema.json` and
//      appends it to the top-level `index.json`.
//
// Pure stdlib + a single dependency (`adm-zip`) so the script is easy to
// audit and runs from a clean checkout.

import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const RAW_BASE =
  process.env.QOREDB_REGISTRY_RAW_BASE ??
  "https://raw.githubusercontent.com/qoredb/qoredb-plugins-registry/main";

function sha256(buffer) {
  return "sha256-" + createHash("sha256").update(buffer).digest("hex");
}

function compareSemver(a, b) {
  // Best-effort: the host treats unparseable versions as compatible, but the
  // registry sorts them lexicographically with a numeric tiebreak so the
  // newest readable version wins.
  const parse = (v) => v.split(".").map((p) => Number.parseInt(p, 10));
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (Number.isNaN(am) || Number.isNaN(bm)) return a.localeCompare(b);
  return am - bm || an - bn || (ap ?? 0) - (bp ?? 0);
}

function summariseCapabilities(caps) {
  if (!caps) return [];
  const flat = [];
  for (const key of ["log", "notify", "storage", "queryRead"]) {
    if (caps[key]) flat.push(key);
  }
  if (caps.http) flat.push("http");
  if (caps.fs) flat.push("fs");
  if (caps.secrets && caps.secrets.length > 0) flat.push("secrets");
  return flat;
}

async function buildVersion(pluginId, version, vdir) {
  const manifestPath = join(vdir, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.id !== pluginId) {
    throw new Error(
      `Plugin id mismatch under ${relative(ROOT, vdir)}: manifest says "${manifest.id}", folder says "${pluginId}"`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `Plugin version mismatch under ${relative(ROOT, vdir)}: manifest says "${manifest.version}", folder says "${version}"`,
    );
  }

  const isExecutable = !!manifest.runtime;
  const zip = new AdmZip();
  zip.addLocalFile(manifestPath, "", "plugin.json");

  if (isExecutable) {
    const entry = manifest.runtime.entry;
    const wasmPath = join(vdir, entry);
    if (!existsSync(wasmPath)) {
      throw new Error(
        `Executable plugin ${pluginId}@${version} declares runtime.entry "${entry}" but the file is missing from ${relative(ROOT, vdir)}`,
      );
    }
    zip.addLocalFile(wasmPath, "", entry);

    // If the manifest carries an integrity hash, cross-check it against the
    // actual WASM bytes — drift here would mean the host refuses to load.
    const declared = manifest.runtime.integrity;
    if (declared) {
      const actual = sha256(await readFile(wasmPath));
      if (declared !== actual) {
        throw new Error(
          `Integrity mismatch for ${pluginId}@${version}: manifest says ${declared}, computed ${actual}. Rebuild the WASM and update the manifest before resubmitting.`,
        );
      }
    }
  }

  const archiveBuffer = zip.toBuffer();
  await writeFile(join(vdir, "plugin.zip"), archiveBuffer);
  const archiveSha = sha256(archiveBuffer);
  await writeFile(join(vdir, "plugin.zip.sha256"), archiveSha + "\n");

  const contributes = manifest.contributes ?? {};
  return {
    version,
    qoredb: manifest.qoredb ?? null,
    category: manifest.category ?? null,
    kind: isExecutable ? "executable" : "declarative",
    runtime: isExecutable
      ? {
          abiVersion: manifest.runtime.abiVersion,
          entry: manifest.runtime.entry,
          hooks: manifest.runtime.hooks ?? [],
          capabilities: summariseCapabilities(manifest.runtime.capabilities),
          integrity: manifest.runtime.integrity ?? null,
        }
      : null,
    contributes: {
      snippets: (contributes.snippets ?? []).length,
      connectionTemplates: (contributes.connectionTemplates ?? []).length,
      themes: (contributes.themes ?? []).length,
      resultViewers: (contributes.resultViewers ?? []).length,
      commands: (contributes.commands ?? []).map((c) => c.id),
    },
    archive: {
      url: `${RAW_BASE}/plugins/${pluginId}/${version}/plugin.zip`,
      sha256: archiveSha,
      sizeBytes: archiveBuffer.length,
    },
    manifestUrl: `${RAW_BASE}/plugins/${pluginId}/${version}/plugin.json`,
  };
}

async function buildIndex() {
  const plugins = [];
  for (const pluginId of (await readdir(PLUGINS_DIR)).sort()) {
    const pluginDir = join(PLUGINS_DIR, pluginId);
    if (!(await stat(pluginDir)).isDirectory()) continue;
    const versions = [];
    for (const version of (await readdir(pluginDir)).sort(compareSemver)) {
      const vdir = join(pluginDir, version);
      if (!(await stat(vdir)).isDirectory()) continue;
      versions.push(await buildVersion(pluginId, version, vdir));
    }
    if (versions.length === 0) continue;
    const latest = versions[versions.length - 1];
    const manifestForName = JSON.parse(
      await readFile(join(pluginDir, latest.version, "plugin.json"), "utf8"),
    );
    plugins.push({
      id: pluginId,
      name: manifestForName.name,
      author: manifestForName.author ?? null,
      description: manifestForName.description ?? null,
      category: manifestForName.category ?? null,
      latestVersion: latest.version,
      kind: latest.kind,
      versions,
    });
  }

  const index = {
    $schema: "./schema/registry-entry.schema.json",
    registryVersion: 1,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    plugins,
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${relative(ROOT, join(ROOT, "index.json"))} (${plugins.length} plugin${plugins.length === 1 ? "" : "s"})`);
}

buildIndex().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
