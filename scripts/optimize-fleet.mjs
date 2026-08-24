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

/**
 * Shifts any animation whose timeline starts before zero so that it starts at
 * zero instead.
 *
 * The authored camera clip opens on a keyframe at -0.0333s — one frame at
 * 30fps — which violates the glTF spec (animation input times must be
 * non-negative) and fails validation. Shifting the whole clip keeps its
 * samplers in sync with each other and keeps keyframe times strictly
 * increasing, which clamping to zero would not: one sampler already has a
 * keyframe at exactly 0.
 */
function startAnimationsAtZero () {
  return (document) => {
    const root = document.getRoot();
    const logger = document.getLogger();

    // Dedup merges identical inputs, so one accessor can back several clips.
    // Retiming in place would drag those other clips along with it.
    const owners = new Map();
    for (const animation of root.listAnimations()) {
      for (const sampler of animation.listSamplers()) {
        const input = sampler.getInput();
        if (!input) continue;
        if (!owners.has(input)) owners.set(input, new Set());
        owners.get(input).add(animation);
      }
    }

    let shiftedAnimations = 0;

    for (const animation of root.listAnimations()) {
      let earliest = Infinity;
      for (const sampler of animation.listSamplers()) {
        const input = sampler.getInput();
        if (input) earliest = Math.min(earliest, input.getMin([])[0]);
      }

      if (!(earliest < 0)) continue;

      const offset = -earliest;
      const retimed = new Map();

      for (const sampler of animation.listSamplers()) {
        const input = sampler.getInput();
        if (!input) continue;

        if (retimed.has(input)) {
          sampler.setInput(retimed.get(input));
          continue;
        }

        const target = owners.get(input).size > 1 ? input.clone() : input;
        const times = target.getArray().slice();
        for (let i = 0; i < times.length; i++) times[i] += offset;
        target.setArray(times);

        sampler.setInput(target);
        retimed.set(input, target);
      }

      shiftedAnimations++;
      logger.debug(`startAnimationsAtZero: shifted "${animation.getName()}" by ${offset.toFixed(5)}s`);
    }

    if (shiftedAnimations > 0) {
      logger.info(`startAnimationsAtZero: retimed ${shiftedAnimations} animation(s) off a negative start`);
    }
  };
}

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
    // Pull any clip that opens before t=0 back onto a legal timeline.
    startAnimationsAtZero(),
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
