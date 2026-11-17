import { decodeFeatureInfo, decodeMapContext, decodeOperations } from './decode.mjs';
import { parseCapabilities, queryableState } from './capabilities.mjs';
import {
  axisOrder, buildFeatureInfoPath, convertBbox, FrameStore,
  pixelParameterNames, positionScope,
} from './wms.mjs';
import { profile } from './profile.mjs';

const FRAME_KEYS = ['version', 'crs', 'bbox', 'dimensions', 'layers', 'styles'];
const KNOWN_VERSIONS = ['1.1.1', '1.3.0'];

export class OperationError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'OperationError';
    this.status = status;
  }
}

function numbers(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function copyFrame(frame) {
  return {
    version: frame.version,
    crs: frame.crs,
    bbox: [...frame.bbox],
    dimensions: [...frame.dimensions],
    layers: [...frame.layers],
    styles: [...frame.styles],
    generation: frame.generation ?? null,
    evidence: frame.evidence || null,
  };
}

function embeddedFrame(operation) {
  const frame = operation.frame || operation.context || {};
  if (!FRAME_KEYS.every(key => frame[key] !== undefined)) return null;
  return copyFrame({ ...frame, generation: operation.generation ?? frame.generation ?? null });
}

export function operationPixel(operation) {
  const pixel = operation.pixel ?? operation.position
    ?? operation.point ?? operation.frame?.pixel ?? operation.frame?.position;
  if (Array.isArray(pixel) && pixel.length === 2 && pixel.every(Number.isInteger)) return [...pixel];
  if (pixel && typeof pixel === 'object') {
    const horizontal = pixel.x ?? pixel.horizontal;
    const vertical = pixel.y ?? pixel.vertical;
    if (Number.isInteger(horizontal) && Number.isInteger(vertical)) return [horizontal, vertical];
  }
  throw new OperationError('操作像素无效');
}

function validateFrame(frame, pixel) {
  if (!KNOWN_VERSIONS.includes(frame.version)) throw new Error('地图版本无效');
  if (typeof frame.crs !== 'string' || !frame.crs) throw new Error('地图坐标系无效');
  if (!Array.isArray(frame.layers) || frame.layers.length === 0) throw new Error('地图图层无效');
  if (!Array.isArray(frame.styles) || frame.styles.length !== frame.layers.length) throw new Error('图层样式与图层不符');
  if (!numbers(frame.bbox, 4)) throw new Error('地图范围无效');
  if (!numbers(frame.dimensions, 2) || !frame.dimensions.every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('地图尺寸无效');
  }
  const [x, y] = pixel;
  if (x < 0 || y < 0 || x >= frame.dimensions[0] || y >= frame.dimensions[1]) {
    throw new Error('像素位置不在地图视口内');
  }
}

function mapRecord(frame, pixel) {
  const [width, height] = frame.dimensions;
  return {
    version: frame.version,
    crs: frame.crs,
    axisOrder: axisOrder(frame.version, frame.crs),
    bbox: [...frame.bbox],
    dimensions: [width, height],
    width,
    height,
    layers: [...frame.layers],
    styles: [...frame.styles],
    generation: frame.generation,
    pixel: [...pixel],
    evidence: frame.evidence || null,
  };
}

function classifyFailure(result) {
  const text = result.bytes.toString('utf8');
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (body?.code === 'LayerNotQueryable' || /LayerNotQueryable/.test(text)) return 'LayerNotQueryable';
  return 'HttpError';
}

function summarize(records) {
  const names = state => records.filter(item => item.state === state).map(item => item.layer);
  return {
    requested: records.length,
    matched: names('matched').length,
    empty: names('empty').length,
    notQueryable: names('not-queryable').length,
    failed: names('failed').length,
    matchedLayers: names('matched'),
    emptyLayers: names('empty'),
    notQueryableLayers: names('not-queryable'),
    failedLayers: names('failed'),
  };
}

export class OperationGateway {
  constructor({ source, catalog, root, frames, infoFormat = 'application/json' }) {
    this.source = source;
    this.catalog = catalog;
    this.frames = frames || new FrameStore(root);
    this.infoFormat = infoFormat;
  }

  async fetch(path) {
    return this.source.request(path);
  }

  async context() {
    const result = await this.fetch(profile.previewPath);
    if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
    const context = decodeMapContext(result.bytes);
    const stored = await this.catalog.put(result.bytes);
    const evidence = {
      digest: stored.digest,
      bytes: stored.bytes,
      mediaType: result.headers['content-type'] || 'application/octet-stream',
      source: result.url,
    };
    const frame = this.frames.remember(context, evidence);
    return { ...result, context, frame };
  }

  // A claim for an older generation must not depend on the editor's current
  // view still being readable.
  async currentOrNull() {
    try {
      return await this.context();
    } catch {
      return null;
    }
  }

  async capabilities() {
    let result;
    try {
      result = await this.fetch(profile.capabilitiesPath);
    } catch {
      return { state: 'unavailable', version: null, layers: new Map() };
    }
    if (result.status !== 200) return { state: 'unavailable', version: null, layers: new Map() };
    try {
      return { state: 'available', ...parseCapabilities(result.bytes), raw: result };
    } catch {
      return { state: 'unavailable', version: null, layers: new Map() };
    }
  }

  async operations() {
    const result = await this.fetch(profile.operationsPath);
    if (result.status !== 200) throw new Error(`操作目录响应：${result.status}`);
    return decodeOperations(result.bytes);
  }

  async operationDisplay(id) {
    const result = await this.fetch(profile.operationsPath);
    if (result.status !== 200) throw new Error(`操作目录响应：${result.status}`);
    const operations = decodeOperations(result.bytes);
    const found = operations.find(item => item.id === id);
    if (!found) throw new OperationError('没有此地图操作', 404);
    return found;
  }

  async operationEvidence(id) {
    const result = await this.fetch(profile.operationsPath);
    if (result.status !== 200) throw new Error(`操作目录响应：${result.status}`);
    const operations = decodeOperations(result.bytes);
    const operation = operations.find(item => item.id === id);
    if (!operation) throw new OperationError('没有此地图操作', 404);
    const stored = await this.catalog.put(result.bytes);
    return {
      operation,
      evidence: {
        digest: stored.digest,
        bytes: stored.bytes,
        mediaType: result.headers['content-type'] || 'application/json',
        source: result.url,
      },
    };
  }

  // Observe the map frame currently shown by the editor. Called when the
  // catalogue is read, so a click made against this view can be reconstructed
  // even after the editor has moved on.
  async observe() {
    return this.context();
  }

  // Bind the claim to the frame that was in force when the operation was
  // issued. The editor may keep zooming or change layers while the answers are
  // still in flight, so the current context is never substituted for an older
  // generation.
  async frameFor(operation, current) {
    const embedded = embeddedFrame(operation);
    if (embedded) return embedded;
    const generation = operation.generation ?? null;
    if (generation === null) {
      throw new OperationError('地图操作没有发起时的地图版本，不能改用当前画面代替', 409);
    }
    if (current && generation === current.frame.generation) return current.frame;
    const recalled = await this.frames.recall(generation);
    if (recalled) return recalled;
    throw new OperationError('操作发起时的地图版本已不可用，不能改用当前画面重查', 409);
  }

  async claim(id, { layers } = {}) {
    if (typeof id !== 'string' || !id) throw new OperationError('缺少地图操作标识');
    const { operation, evidence } = await this.operationEvidence(id);
    // The frame is captured before the queries start. Later zooming or layer
    // changes in the editor cannot alter it, and a late answer still belongs to
    // this operation's generation.
    const [current, capabilities] = await Promise.all([this.currentOrNull(), this.capabilities()]);
    const frame = await this.frameFor(operation, current);
    const pixel = operationPixel(operation);
    validateFrame(frame, pixel);

    const requested = layers?.length
      ? [...new Set(layers)].filter(name => operation.queryLayers.includes(name))
      : [...new Set(operation.queryLayers)];
    if (layers?.length && requested.length !== new Set(layers).size) {
      throw new OperationError('地图操作不包含指定的查询图层');
    }
    if (requested.length === 0) throw new OperationError('地图操作没有可查询的图层');

    const capabilityRecord = await this.capabilityRecord(capabilities);
    // The WMS version is taken from the source's capabilities so I/J vs X/Y and
    // the BBOX axis order follow what that source actually supports.
    const requestVersion = KNOWN_VERSIONS.includes(capabilities.version)
      ? capabilities.version : frame.version;
    const bbox = convertBbox(frame.bbox, frame.version, requestVersion, frame.crs);
    const versionMismatch = capabilities.state === 'available' && capabilities.version !== frame.version;

    const records = [];
    for (const layer of requested) {
      records.push(await this.queryLayer({ frame, requestVersion, bbox, pixel, layer, capabilities }));
    }
    await this.frames.flush();
    return {
      kind: 'map-operation',
      source: frame.evidence?.source || this.source.base.href,
      context: frame.evidence || null,
      operation: { id: operation.id, generation: frame.generation, pixel: [...pixel],
        queryLayers: [...operation.queryLayers], evidence },
      map: mapRecord(frame, pixel),
      requestVersion,
      requestBbox: [...bbox],
      versionMismatch,
      scope: 'pixel',
      scopeNote: positionScope,
      capabilities: capabilityRecord,
      layers: records,
      summary: summarize(records),
    };
  }

  async capabilityRecord(capabilities) {
    if (capabilities.state !== 'available') return { state: capabilities.state, version: null };
    const stored = await this.catalog.put(capabilities.raw.bytes);
    return {
      state: capabilities.state,
      version: capabilities.version,
      digest: stored.digest,
      bytes: stored.bytes,
      mediaType: capabilities.raw.headers['content-type'] || 'application/xml',
    };
  }

  async queryLayer({ frame, requestVersion, bbox, pixel, layer, capabilities }) {
    const capability = capabilities.state === 'available' ? queryableState(capabilities, layer) : null;
    const base = {
      layer,
      position: frame.layers.includes(layer) ? frame.layers.indexOf(layer) : null,
      style: frame.layers.includes(layer) ? frame.styles[frame.layers.indexOf(layer)] ?? '' : null,
      generation: frame.generation,
      capability,
    };

    const path = buildFeatureInfoPath({
      map: { ...frame, version: requestVersion, bbox, pixel, infoFormat: this.infoFormat }, layer,
    });
    const request = {
      path,
      version: requestVersion,
      crs: frame.crs,
      axisOrder: axisOrder(requestVersion, frame.crs),
      crsParameter: requestVersion === '1.3.0' ? 'CRS' : 'SRS',
      pixelParameters: pixelParameterNames(requestVersion),
      pixel: [...pixel],
      bbox: [...bbox],
      dimensions: [...frame.dimensions],
      layers: [...frame.layers],
      styles: [...frame.styles],
      queryLayer: layer,
      infoFormat: this.infoFormat,
    };
    let result;
    try {
      result = await this.fetch(path);
    } catch (error) {
      if (capability === false) {
        return {
          ...base, state: 'not-queryable', queryable: false, code: 'LayerNotQueryable',
          evidence: 'capabilities', matched: null, featureCount: null, features: null,
          request, response: null,
          detail: `来源能力标明该图层不可查询；本次请求未完成：${error.message}`,
        };
      }
      return { ...base, state: 'failed', code: 'RequestFailed', evidence: 'response',
        matched: null, featureCount: null, features: null, request, response: null, detail: error.message };
    }
    const response = await this.save(result);
    if (result.status !== 200) {
      const code = classifyFailure(result);
      if (code === 'LayerNotQueryable' || capability === false) {
        return {
          ...base, state: 'not-queryable', queryable: false,
          code: code === 'LayerNotQueryable' ? code : 'LayerNotQueryable',
          evidence: code === 'LayerNotQueryable' ? 'response' : 'capabilities',
          matched: null, featureCount: null, features: null, request, response,
          detail: '该层不可查询，本次没有取回可用信息。',
        };
      }
      return {
        ...base, state: 'failed', code, evidence: 'response',
        matched: null, featureCount: null, features: null, request, response,
        detail: `来源响应状态 ${result.status}。`,
      };
    }
    let collection;
    try {
      collection = decodeFeatureInfo(result.bytes);
    } catch {
      if (capability === false) {
        return {
          ...base, state: 'not-queryable', queryable: false, code: 'LayerNotQueryable',
          evidence: 'capabilities', matched: null, featureCount: null, features: null, request, response,
          detail: '来源能力标明该图层不可查询，应答也不能作为该层命中。',
        };
      }
      return {
        ...base, state: 'failed', code: 'UnusableResponse', evidence: 'response',
        matched: null, featureCount: null, features: null, request, response,
        detail: '应答不是可用的 FeatureCollection。',
      };
    }
    const matched = collection.features.length > 0;
    // The source capabilities decide whether a layer is queryable. A stray
    // FeatureCollection from such a layer is kept as raw evidence but must not
    // be presented as a successful hit.
    if (capability === false) {
      return {
        ...base, state: 'not-queryable', queryable: false, code: 'LayerNotQueryable',
        evidence: 'capabilities', matched: null, featureCount: null, features: null,
        request, response,
        observedFeatureCount: collection.features.length,
        capabilityConflict: matched,
        detail: '来源能力标明该图层不可查询，本次没有取回可用信息。',
      };
    }
    return {
      ...base, state: matched ? 'matched' : 'empty', queryable: true, evidence: 'response',
      matched, featureCount: collection.features.length,
      features: collection.features, request, response,
      ...(matched ? {} : { detail: '该图层可以查询，但这次点位没有命中任何要素。' }),
    };
  }

  async save(result) {
    const stored = await this.catalog.put(result.bytes);
    return {
      digest: stored.digest,
      bytes: stored.bytes,
      mediaType: result.headers['content-type'] || 'application/octet-stream',
      httpStatus: result.status,
      source: result.url,
    };
  }
}
