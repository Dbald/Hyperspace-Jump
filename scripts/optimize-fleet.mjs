/**
 * Fleet model optimization pipeline.
 *
 * Reads the authored glTF + .bin source and writes a single compressed GLB for
 * the web build. The source assets stay in the repository untouched.
 *
 * Usage: node scripts/optimize-fleet.mjs [--input <path>] [--output <path>]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  prune,
  reorder,
  resample,
  sparse,
  textureCompress,
  weld
} from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = 'assets/Fleet_Model/rebel_fleet_anim_corevetteview.gltf';
const DEFAULT_OUTPUT = 'assets/Fleet_Model/rebel_fleet_optimized.glb';

// Colour data tolerates lossy compression; data maps (metal/rough, normal,
// occlusion) encode vectors and scalars, so they get a near-lossless setting.
const COLOR_QUALITY = 82;
const DATA_QUALITY = 94;
const MAX_TEXTURE_SIZE = 1024;

function parseArgs (argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input' && value) args.input = value;
    else if (flag === '--output' && value) args.output = value;
    else throw new Error(`Unrecognized argument: ${flag}`);
  }
  return args;
}

function formatBytes (bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

async function sourceBytes (documentPath) {
  // A .gltf document carries its geometry in sibling .bin files; count those too.
  const stats = await fs.stat(documentPath);
  if (path.extname(documentPath).toLowerCase() === '.glb') return stats.size;

  const json = JSON.parse(await fs.readFile(documentPath, 'utf8'));
  const dir = path.dirname(documentPath);
  let total = stats.size;
  for (const buffer of json.buffers ?? []) {
    if (!buffer.uri || buffer.uri.startsWith('data:')) continue;
    total += (await fs.stat(path.join(dir, decodeURIComponent(buffer.uri)))).size;
  }
  for (const image of json.images ?? []) {
    if (!image.uri || image.uri.startsWith('data:')) continue;
    total += (await fs.stat(path.join(dir, decodeURIComponent(image.uri)))).size;
  }
  return total;
}

function summarize (document) {
  const root = document.getRoot();
  let triangles = 0;
  let vertices = 0;

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getIndices();
      vertices += position ? position.getCount() : 0;
      triangles += indices ? indices.getCount() / 3 : (position ? position.getCount() / 3 : 0);
    }
  }

  return {
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    animations: root.listAnimations().length,
    triangles: Math.round(triangles),
    vertices
  };
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(ROOT, args.input);
  const outputPath = path.resolve(ROOT, args.output);

  await MeshoptEncoder.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule()
    });

  const before = await sourceBytes(inputPath);
  const document = await io.read(inputPath);
  const beforeStats = summarize(document);

  await document.transform(
    // Collapse duplicate meshes, materials, textures and accessors first so
    // every later pass has less work to do.
    dedup(),
    // Drop unreferenced properties, including vertex attributes and UV sets no
    // material actually samples.
    prune({ keepAttributes: false }),
    // Losslessly remove redundant animation keyframes.
    resample(),
    // Merge vertices that are identical across position, normal and UV.
    weld(),
    // Reorder indices and vertices for GPU cache locality; also improves the
    // entropy coding that Draco applies next.
    reorder({ encoder: MeshoptEncoder, target: 'performance' }),
    // Store zero-filled accessors sparsely.
    sparse(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      slots: /baseColorTexture|emissiveTexture/,
      resize: [MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE],
      quality: COLOR_QUALITY
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      slots: /metallicRoughnessTexture|normalTexture|occlusionTexture/,
      resize: [MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE],
      quality: DATA_QUALITY
    }),
    // Quantized, entropy-coded geometry. Decoded by the vendored decoder in
    // assets/vendor/draco.
    draco({ method: 'edgebreaker' })
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await io.write(outputPath, document);

  const after = (await fs.stat(outputPath)).size;
  const afterStats = summarize(document);

  console.log(`source  ${path.relative(ROOT, inputPath)}  ${formatBytes(before)}`);
  console.log(`output  ${path.relative(ROOT, outputPath)}  ${formatBytes(after)}`);
  console.log(`saved   ${formatBytes(before - after)} (${(100 - (after / before) * 100).toFixed(1)}% smaller)`);
  console.log(
    `meshes ${beforeStats.meshes}→${afterStats.meshes}  ` +
    `materials ${beforeStats.materials}→${afterStats.materials}  ` +
    `textures ${beforeStats.textures}→${afterStats.textures}  ` +
    `triangles ${beforeStats.triangles.toLocaleString()}→${afterStats.triangles.toLocaleString()}  ` +
    `vertices ${beforeStats.vertices.toLocaleString()}→${afterStats.vertices.toLocaleString()}  ` +
    `animations ${afterStats.animations}`
  );
}

await main();
