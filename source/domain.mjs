export function dispatch({ url }) {
  if (url.pathname !== '/wms') return null;
  const parameters = Object.fromEntries([...url.searchParams].map(([name, value]) => [name.toUpperCase(), value]));
  if (parameters.REQUEST !== 'GetFeatureInfo') return { status: 400, json: { error: '不支持此地图操作' } };
  const layers = (parameters.QUERY_LAYERS || '').split(',');
  if (layers.includes('fire:access')) return { status: 400, json: { code: 'LayerNotQueryable', layer: 'fire:access' } };
  const modern = parameters.VERSION === '1.3.0';
  const horizontal = Number(parameters[modern ? 'I' : 'X']);
  const vertical = Number(parameters[modern ? 'J' : 'Y']);
  if (![horizontal, vertical].every(Number.isFinite)) return { status: 400, json: { error: '像素参数与版本不符' } };
  return { json: { type: 'FeatureCollection', query: parameters,
    features: horizontal === 400 && vertical === 300 ? [{ id: 'hydrant-a', properties: { status: 'available' } }] : [] } };
}
