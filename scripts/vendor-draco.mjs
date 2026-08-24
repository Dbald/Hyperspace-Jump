/**
 * Copies the glTF Draco decoder out of the `three` build that A-Frame bundles
 * into assets/vendor/draco, so the deployed site serves its own decoder.
 *
 * Usage: node scripts/vendor-draco.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'assets/vendor/draco');
const DRACO_SUBPATH = 'examples/jsm/libs/draco/gltf';
const FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];

async function exists (target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `three` does not export ./package.json, so walk up from its resolved entry
 * point until the decoder directory turns up.
 */
async function findPackageRoot () {
  let dir = path.dirname(require.resolve('three'));

  while (dir !== path.dirname(dir)) {
    if (await exists(path.join(dir, DRACO_SUBPATH))) return dir;
    dir = path.dirname(dir);
  }

  throw new Error(`Could not locate ${DRACO_SUBPATH} under the installed three package.`);
}

const packageRoot = await findPackageRoot();
const source = path.join(packageRoot, DRACO_SUBPATH);

await fs.mkdir(DEST, { recursive: true });
for (const file of FILES) {
  await fs.copyFile(path.join(source, file), path.join(DEST, file));
  const { size } = await fs.stat(path.join(DEST, file));
  console.log(`${file.padEnd(24)} ${(size / 1024).toFixed(0)} KB`);
}

const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
console.log(`copied from ${manifest.name}@${manifest.version}`);
