function document(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料不是对象');
  return value;
}

export function decode(bytes) {
  const value = document(bytes);
  if (!['1.1.1', '1.3.0'].includes(value.version) || !Array.isArray(value.layers) || value.bbox?.length !== 4 || !value.width || !value.height) throw new Error('地图上下文无效');
  if (!value.bbox.every(Number.isFinite)) throw new Error('地图范围无效');
  return { version: value.version, layers: value.layers, styles: value.styles || [], crs: value.crs,
    bbox: value.bbox, dimensions: [value.width, value.height], generation: value.generation };
}
