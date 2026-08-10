// Remote-facing treegen tools. treegen's own MCP server writes GLB files to
// disk and returns paths; a path means nothing to a remote caller, and a 664KB
// GLB inlined as base64 would flood the model's context. So every artifact
// goes to the store and the caller gets a short-lived URL.
//
// The geometry itself comes from the treegen package (github:andreglegg/treegen)
// rather than a vendored copy — copies drift. The param schema below mirrors
// treegen's own mcp/server.js paramShape; when treegen's surface grows, this
// file is the one other place to update.
import { z } from 'zod';
import { buildTree, meshStats, presets, randomParams } from 'treegen/generator';
import { exportGlb, exportObj, exportGameGlb, exportForestGlb } from 'treegen/export';

const SPECIES = ['round', 'oak', 'acacia', 'willow', 'pine', 'birch', 'poplar', 'palm', 'baobab'];
const LEAF_STYLES = ['clustered', 'angular', 'rounded', 'flat', 'needles'];
const FORMATS = ['glb', 'obj', 'json'];

const paramShape = {
  species: z.enum(SPECIES).optional().describe('Tree species / silhouette'),
  seed: z.number().int().min(1).max(999999).optional().describe('Deterministic seed — same seed reproduces the same tree'),
  height: z.number().min(2).max(50).optional().describe('Metres, FULL-GROWN. Above ~15m the trunk blends toward columnar giant proportions'),
  trunkRadius: z.number().min(0.15).max(2.5).optional(),
  branchCount: z.number().int().min(4).max(18).optional(),
  branchSpread: z.number().min(0.45).max(2.2).optional(),
  canopySize: z.number().min(0.9).max(8).optional(),
  age: z.number().min(0).max(1).optional().describe('0 sapling, 0.5 mature, 1 ancient — plays the tree along its growth curve (size, crown shape, droop, flare, gnarl, root spurs, deadwood)'),
  leafDensity: z.number().int().min(0).max(64).optional().describe('Number of foliage clusters. 0 = bare/winter tree: no foliage, terminals grow fine twigs instead'),
  leafShape: z.number().min(0.15).max(1).optional().describe('Leaf roundness'),
  leafStyle: z.enum(LEAF_STYLES).optional(),
  leafSize: z.number().min(0.45).max(1.7).optional(),
  leafVariation: z.number().min(0).max(1).optional(),
  detail: z.number().int().min(0).max(2).optional().describe('0 low-poly, 1 game-ready, 2 hero'),
  lean: z.number().min(0).max(0.55).optional(),
  brokenTop: z.boolean().optional().describe('Snap the trunk at ~70% height with a jagged shear — a standing-dead snag top'),
  leafPalette: z.number().int().min(0).max(8).optional(),
  barkPalette: z.number().int().min(0).max(7).optional(),
};

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function registerTreegenTools(server, { store }) {
  async function build(params, format = 'glb') {
    const settings = { ...presets.meadow, ...params };
    const group = buildTree(params);
    const stats = meshStats(group);

    let bytes;
    if (format === 'json') bytes = Buffer.from(JSON.stringify(settings, null, 2), 'utf8');
    else if (format === 'obj') bytes = Buffer.from(exportObj(group), 'utf8');
    else bytes = Buffer.from(await exportGlb(group)); // exportGlb yields an ArrayBuffer

    const artifact = await store.put(bytes, format);
    return {
      url: artifact.url,
      expiresAt: new Date(artifact.expiresAt).toISOString(),
      format,
      species: settings.species,
      seed: settings.seed,
      meshes: stats.meshes,
      triangles: stats.triangles,
      sizeKB: Math.round(artifact.sizeBytes / 102.4) / 10,
    };
  }

  function rejectOutPath(args) {
    if (args.outPath !== undefined) {
      throw new Error('outPath is not supported on the remote server — the generated file is returned as a download URL.');
    }
  }

  const handlers = {
    async generate_tree({ preset, format = 'glb', ...params }) {
      rejectOutPath(params);
      const base = preset ? presets[preset] : {};
      return ok(await build({ ...base, ...params }, format));
    },

    async random_tree({ species, rollSeed, format = 'glb', ...rest }) {
      rejectOutPath(rest);
      const roll = randomParams(rollSeed ?? 1);
      const params = { ...presets.meadow, ...roll };
      if (species) params.species = species;
      const result = await build(params, format);
      return ok({ ...result, rolledParams: roll });
    },

    async list_presets() {
      return ok(presets);
    },

    async export_game_tree({ preset, ...params }) {
      rejectOutPath(params);
      const merged = { ...(preset ? presets[preset] : {}), ...params };
      const settings = { ...presets.meadow, ...merged };
      const bytes = Buffer.from(await exportGameGlb(merged));
      const artifact = await store.put(bytes, 'glb');
      return ok({
        url: artifact.url,
        expiresAt: new Date(artifact.expiresAt).toISOString(),
        format: 'glb',
        species: settings.species,
        seed: settings.seed,
        lods: ['LOD0', 'LOD1', 'LOD2'],
        sizeKB: Math.round(artifact.sizeBytes / 102.4) / 10,
      });
    },

    async export_forest({ preset, count = 9, seedBase = 1, agedSpread = 0.35, ...params }) {
      rejectOutPath(params);
      const merged = { ...(preset ? presets[preset] : {}), ...params };
      const bytes = Buffer.from(await exportForestGlb({ params: merged, count, seedBase, agedSpread }));
      const artifact = await store.put(bytes, 'glb');
      return ok({
        url: artifact.url,
        expiresAt: new Date(artifact.expiresAt).toISOString(),
        format: 'glb',
        count,
        seedBase,
        sizeKB: Math.round(artifact.sizeBytes / 102.4) / 10,
      });
    },
  };

  server.registerTool('generate_tree', {
    title: 'Generate tree',
    description:
      'Generate a stylized low-poly tree. Start from a preset (optional) and override any params. Returns a short-lived download URL for the GLB (default), OBJ, or preset JSON, plus mesh and triangle counts. Supports the full range: 2m saplings to 50m giants (age param), winter/bare trees (leafDensity 0), and snags (brokenTop).',
    inputSchema: {
      preset: z.enum(Object.keys(presets)).optional().describe('Preset to start from before applying overrides'),
      format: z.enum(FORMATS).optional().describe('Output format (default glb)'),
      ...paramShape,
    },
  }, handlers.generate_tree);

  server.registerTool('random_tree', {
    title: 'Random tree',
    description: 'Roll a random seed and shape (mirrors the app\'s "Random variation") and generate a tree.',
    inputSchema: {
      species: z.enum(SPECIES).optional(),
      rollSeed: z.number().int().min(1).max(999999).optional().describe('Seed used to roll the random params (not the tree seed)'),
      format: z.enum(FORMATS).optional(),
    },
  }, handlers.random_tree);

  server.registerTool('list_presets', {
    title: 'List presets',
    description: 'List the built-in tree presets and their parameters.',
    inputSchema: {},
  }, handlers.list_presets);

  server.registerTool('export_game_tree', {
    title: 'Export game-ready tree (LOD GLB)',
    description:
      'Export a game-ready GLB: the same params built at detail 2/1/0, each merged down to at most 2 vertex-colored meshes (bark + foliage), parented under nodes named LOD0/LOD1/LOD2. Engines wire LOD visibility ranges to those nodes; each LOD renders in <=2 draw calls. Returns a short-lived download URL.',
    inputSchema: {
      preset: z.enum(Object.keys(presets)).optional().describe('Preset to start from before applying overrides'),
      ...paramShape,
    },
  }, handlers.export_game_tree);

  server.registerTool('export_forest', {
    title: 'Export forest kit (GLB)',
    description:
      'Export a forest kit GLB: `count` merged trees seeded seedBase+i with real ages jittered across agedSpread, laid out on a spaced grid under nodes tree_0..N. Deterministic: the same seedBase always produces the same forest. Returns a short-lived download URL.',
    inputSchema: {
      preset: z.enum(Object.keys(presets)).optional().describe('Preset to start from before applying overrides'),
      count: z.number().int().min(1).max(32).optional().describe('Number of trees in the kit (default 9)'),
      seedBase: z.number().int().min(1).max(999999).optional().describe('Base seed; tree i uses seedBase+i (default 1)'),
      agedSpread: z.number().min(0).max(0.6).optional().describe('Age jitter around the base age (default 0.35)'),
      ...paramShape,
    },
  }, handlers.export_forest);

  return handlers;
}
