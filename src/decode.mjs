function json(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  return JSON.parse(text);
}

function document(bytes) {
  const value = json(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料不是对象');
  return value;
}

export function decode(bytes) {
  const value = document(bytes);
  if (!['1.1.1', '1.3.0'].includes(value.version) || !Array.isArray(value.layers) || value.bbox?.length !== 4 || !value.width || !value.height) throw new Error('地图上下文无效');
  if (!value.bbox.every(Number.isFinite)) throw new Error('地图范围无效');
  if (value.layers.some(name => typeof name !== 'string' || !name)) throw new Error('地图图层无效');
  if (value.styles !== undefined && (!Array.isArray(value.styles) || value.styles.some(style => typeof style !== 'string'))) throw new Error('图层样式无效');
  const styles = value.styles ?? value.layers.map(() => '');
  if (styles.length !== value.layers.length) throw new Error('图层样式与图层不符');
  return { version: value.version, layers: value.layers, styles, crs: value.crs,
    bbox: value.bbox, dimensions: [value.width, value.height], generation: value.generation };
}

export const decodeMapContext = decode;

function optionalPixel(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) return [...value];
  if (value && typeof value === 'object') {
    const horizontal = value.x ?? value.horizontal;
    const vertical = value.y ?? value.vertical;
    if (Number.isInteger(horizontal) && Number.isInteger(vertical)) return [horizontal, vertical];
  }
  return undefined;
}

export function decodeOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('地图操作无效');
  if (typeof value.id !== 'string' || !value.id) throw new Error('地图操作缺少标识');
  const queryLayers = value.queryLayers ?? value.query_layers
    ?? (Array.isArray(value.layers) ? value.layers : null);
  if (!Array.isArray(queryLayers) || queryLayers.some(name => typeof name !== 'string' || !name)) {
    throw new Error('地图操作图层无效');
  }
  const frame = value.frame || value.context || {};
  const generation = value.generation ?? frame.generation ?? null;
  const pixel = optionalPixel(value.pixel ?? value.position
    ?? value.point ?? frame.pixel ?? frame.position);
  return { ...value, id: value.id, generation,
    pixel, queryLayers: [...queryLayers] };
}

export function decodeOperations(bytes) {
  const value = json(bytes);
  const list = Array.isArray(value) ? value : value?.operations;
  if (!Array.isArray(list)) throw new Error('地图操作目录无效');
  return list.map(decodeOperation);
}
export function decodeFeatureInfo(bytes) {
  const value = document(bytes);
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) throw new Error('查询应答不是 FeatureCollection');
  return value;
}
