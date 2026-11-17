import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const positionScope = '该结果只代表操作发起时所点像素位置的返回，不代表查询图层或整层的全量资料。';

const geographic = /^(?:EPSG:|URN:OGC:DEF:CRS:EPSG:)(\d+)$/i;
const geographic84 = /^(?:CRS:84|OGC:CRS84)$/i;

export function axisOrder(version, crs) {
  const code = String(crs || '').trim();
  if (geographic84.test(code)) return ['longitude', 'latitude'];
  if (String(version) !== '1.3.0') return ['longitude', 'latitude'];
  const match = geographic.exec(code);
  if (!match) return ['longitude', 'latitude'];
  const number = Number(match[1]);
  // WMS 1.3.0 transmits the geographic CRSs (EPSG 4000–4999) as latitude,
  // longitude. Projected CRSs such as EPSG:3857 stay easting, northing.
  return number >= 4000 && number <= 4999 ? ['latitude', 'longitude'] : ['longitude', 'latitude'];
}

export function pixelParameterNames(version) {
  return String(version) === '1.3.0' ? ['I', 'J'] : ['X', 'Y'];
}

export function crsParameterName(version) {
  return String(version) === '1.3.0' ? 'CRS' : 'SRS';
}

export function styleList(layers, styles = []) {
  return layers.map((_, index) => styles[index] ?? '').join(',');
}

export function convertBbox(bbox, fromVersion, toVersion, crs) {
  const from = axisOrder(fromVersion, crs);
  const to = axisOrder(toVersion, crs);
  if (from[0] === to[0]) return [...bbox];
  const [firstMin, secondMin, firstMax, secondMax] = bbox;
  return [secondMin, firstMin, secondMax, firstMax];
}

export function buildFeatureInfoParameters({ map, layer }) {
  const [horizontal, vertical] = map.pixel;
  const [pixelX, pixelY] = pixelParameterNames(map.version);
  const [width, height] = map.dimensions;
  if (!Number.isInteger(horizontal) || !Number.isInteger(vertical)
    || horizontal < 0 || horizontal >= width || vertical < 0 || vertical >= height) {
    throw new Error('像素位置不在地图视口内');
  }
  // The stored bbox already follows the axis order of its own WMS version.
  const parameters = new URLSearchParams();
  parameters.set('SERVICE', 'WMS');
  parameters.set('REQUEST', 'GetFeatureInfo');
  parameters.set('VERSION', map.version);
  parameters.set(crsParameterName(map.version), map.crs);
  parameters.set('BBOX', map.bbox.join(','));
  parameters.set('WIDTH', String(width));
  parameters.set('HEIGHT', String(height));
  parameters.set('LAYERS', map.layers.join(','));
  parameters.set('STYLES', styleList(map.layers, map.styles));
  parameters.set('QUERY_LAYERS', layer);
  parameters.set(pixelX, String(horizontal));
  parameters.set(pixelY, String(vertical));
  parameters.set('INFO_FORMAT', map.infoFormat || 'application/json');
  parameters.sort();
  return parameters;
}

export function buildFeatureInfoPath({ map, layer }) {
  return `/wms?${buildFeatureInfoParameters({ map, layer }).toString()}`;
}

function stableKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export class FrameStore {
  constructor(root, { limit = 64 } = {}) {
    this.root = root || null;
    this.limit = limit;
    this.memory = new Map();
    this.serial = Promise.resolve();
  }

  remember(context, evidence = null) {
    const frame = {
      version: context.version,
      crs: context.crs,
      bbox: [...context.bbox],
      dimensions: [...context.dimensions],
      layers: [...context.layers],
      styles: [...context.styles],
      generation: context.generation ?? null,
      evidence,
    };
    const generation = frame.generation;
    if (generation === null) return frame;
    // The first observation of a generation is the best evidence of that view.
    // A late display update must not rewrite the frame an operation refers to.
    if (this.memory.has(generation)) return this.memory.get(generation);
    this.memory.set(generation, frame);
    while (this.memory.size > this.limit) this.memory.delete(this.memory.keys().next().value);
    if (this.root) {
      const path = join(this.root, 'frames', `${stableKey(generation)}.json`);
      const payload = Buffer.from(JSON.stringify(frame, null, 2));
      const write = this.serial.then(() => this.writeOnce(path, payload));
      this.serial = write.catch(() => {});
    }
    return frame;
  }

  async writeOnce(path, bytes) {
    await mkdir(join(this.root, 'frames'), { recursive: true });
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.atomic(path, bytes);
  }

  async atomic(path, bytes) {
    await mkdir(join(this.root, 'frames'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async recall(generation) {
    if (generation === null || generation === undefined) return null;
    const remembered = this.memory.get(generation);
    if (remembered) return remembered;
    if (!this.root) return null;
    try {
      const frame = JSON.parse(await readFile(join(this.root, 'frames', `${stableKey(generation)}.json`), 'utf8'));
      if (frame.generation !== generation) return null;
      this.memory.set(generation, frame);
      return frame;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async flush() {
    await this.serial;
  }
}
