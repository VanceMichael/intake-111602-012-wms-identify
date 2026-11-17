import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/catalog.mjs';
import { OperationGateway } from '../src/operation.mjs';
import { FrameStore } from '../src/wms.mjs';
import { startApplication } from '../src/app.mjs';
import { startSource } from '../source/service.mjs';

async function claim(app, id, input = {}) {
  const response = await fetch(`${app.base}/operations/${id}/receipts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
}

test('领取绑定操作发起时的地图帧，不随之后缩放改变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-'));
  const source = await startSource({ scenario: 'transition' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    // Observing the catalogue records the map frame the click belongs to.
    const operations = await fetch(`${app.base}/operations`).then(response => response.json());
    assert.deepEqual(operations.map(item => item.id), ['click-1']);
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });

    const { status, body: receipt } = await claim(app, 'click-1');
    assert.equal(status, 201);
    assert.equal(receipt.kind, 'map-operation');
    assert.equal(receipt.map.generation, 'view-1');
    assert.deepEqual(receipt.map.bbox, [30, 120, 31, 121]);
    assert.deepEqual(receipt.map.layers, ['fire:hydrants', 'fire:access']);
    assert.deepEqual(receipt.map.styles, ['', 'night']);
    assert.deepEqual(receipt.map.pixel, [400, 300]);
    assert.equal(receipt.map.version, '1.3.0');
    assert.equal(receipt.map.crs, 'EPSG:4326');
    assert.equal(receipt.operation.generation, 'view-1');

    // The old request's answer is stored as the raw response of that operation.
    const record = receipt.layers.find(item => item.layer === 'fire:hydrants');
    assert.equal(record.state, 'matched');
    assert.equal(record.featureCount, 1);
    const raw = await app.catalog.object(record.response.digest);
    assert.deepEqual(JSON.parse(raw).features.map(feature => feature.id), ['hydrant-a']);
    assert.match(JSON.parse(raw).query.BBOX, /^30,120,31,121$/);
    assert.equal(JSON.parse(raw).query.I, '400');

    // The view layer order, styles and bbox in the request are the captured ones.
    assert.deepEqual(record.request.layers, ['fire:hydrants', 'fire:access']);
    assert.deepEqual(record.request.styles, ['', 'night']);
    assert.deepEqual(record.request.pixel, [400, 300]);
    assert.deepEqual(record.request.pixelParameters, ['I', 'J']);
    assert.deepEqual(record.request.axisOrder, ['latitude', 'longitude']);

    // The receipt survives a restart and still carries the map evidence.
    const reopened = await new Catalog(directory).get(receipt.id);
    assert.equal(reopened.map.generation, 'view-1');
    assert.equal(reopened.summary.matched, 1);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('不可查询与可以查询但没有命中分别说明', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-'));
  const source = await startSource();
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const { body: receipt } = await claim(app, 'click-2');
    const hydrants = receipt.layers.find(item => item.layer === 'fire:hydrants');
    assert.equal(hydrants.state, 'empty');
    assert.equal(hydrants.queryable, true);
    assert.equal(hydrants.matched, false);
    assert.equal(hydrants.featureCount, 0);
    assert.match(hydrants.detail, /没有命中/);

    const access = receipt.layers.find(item => item.layer === 'fire:access');
    assert.equal(access.state, 'not-queryable');
    assert.equal(access.queryable, false);
    assert.equal(access.matched, null);
    assert.equal(access.featureCount, null);
    assert.equal(access.code, 'LayerNotQueryable');
    assert.equal(receipt.summary.notQueryable, 1);
    assert.equal(receipt.summary.empty, 1);
    assert.deepEqual(receipt.summary.notQueryableLayers, ['fire:access']);
    assert.deepEqual(receipt.summary.emptyLayers, ['fire:hydrants']);

    // A pixel answer only speaks for this position, not the whole layer.
    assert.equal(receipt.scope, 'pixel');
    assert.match(receipt.scopeNote, /像素位置/);
    assert.ok(receipt.layers.every(item => Array.isArray(item.request.pixel) || item.request === null));
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('来源能力版本决定像素参数与轴序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-'));
  const source = await startSource({ scenario: 'operations' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    await fetch(`${app.base}/operations`).then(response => response.json());
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });

    const { body: receipt } = await claim(app, 'click-1');
    assert.equal(receipt.map.version, '1.3.0');
    assert.equal(receipt.map.bbox[0], 30);
    assert.equal(receipt.requestVersion, '1.1.1');
    assert.equal(receipt.versionMismatch, true);
    assert.deepEqual(receipt.requestBbox, [120, 30, 121, 31]);

    const record = receipt.layers.find(item => item.layer === 'fire:hydrants');
    assert.deepEqual(record.request.pixelParameters, ['X', 'Y']);
    assert.deepEqual(record.request.axisOrder, ['longitude', 'latitude']);
    assert.equal(record.request.crsParameter, 'SRS');
    const query = JSON.parse(Buffer.from(await app.catalog.object(record.response.digest)).toString());
    assert.equal(query.query.X, '400');
    assert.equal(query.query.Y, '300');
    assert.equal(query.query.I, undefined);
    assert.equal(query.query.BBOX, '120,30,121,31');
    assert.equal(query.query.VERSION, '1.1.1');
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('旧请求晚于画面切换返回仍属于旧操作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-'));
  const catalog = await new Catalog(directory).initialize();
  const viewOne = { version: '1.3.0', layers: ['fire:hydrants'], styles: [''], crs: 'EPSG:4326',
    bbox: [30, 120, 31, 121], width: 800, height: 600, generation: 'view-1' };
  const viewTwo = { ...viewOne, bbox: [30.4, 120.4, 30.6, 120.6], generation: 'view-2' };
  let contextBody = viewOne;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const source = {
    base: new URL('http://127.0.0.1:9/'),
    async request(path) {
      requests.push(path);
      if (path === '/map/context') {
        return { status: 200, headers: { 'content-type': 'application/json' },
          bytes: Buffer.from(JSON.stringify(contextBody)), url: 'http://127.0.0.1:9/map/context' };
      }
      if (path === '/map/operations') {
        return { status: 200, headers: { 'content-type': 'application/json' },
          bytes: Buffer.from(JSON.stringify({ operations: [
            { id: 'click-9', generation: 'view-1', pixel: [400, 300], queryLayers: ['fire:hydrants'] },
          ] })), url: 'http://127.0.0.1:9/map/operations' };
      }
      if (path === '/wms/capabilities') {
        return { status: 200, headers: { 'content-type': 'application/xml' },
          bytes: Buffer.from('<WMS_Capabilities version="1.3.0"><Capability><Layer><Layer queryable="1"><Name>fire:hydrants</Name></Layer></Layer></Capability></WMS_Capabilities>'),
          url: 'http://127.0.0.1:9/wms/capabilities' };
      }
      await gate;
      // This answer describes view-1 even though the editor now shows view-2.
      const query = new URL(path, 'http://localhost').searchParams;
      return { status: 200, headers: { 'content-type': 'application/json' },
        bytes: Buffer.from(JSON.stringify({ type: 'FeatureCollection', query: Object.fromEntries(query),
          features: [{ id: 'hydrant-a' }] })), url: `http://127.0.0.1:9${path}` };
    },
  };
  const gateway = new OperationGateway({ source, catalog, frames: new FrameStore(directory) });

  // Observe view-1, issue the claim, then let the editor move to view-2 while
  // the answer is still in flight.
  const pending = gateway.claim('click-9');
  await new Promise(resolve => setTimeout(resolve, 10));
  contextBody = viewTwo;
  await gateway.observe();
  release();
  const claim = await pending;

  assert.equal(claim.map.generation, 'view-1');
  assert.deepEqual(claim.map.bbox, [30, 120, 31, 121]);
  const record = claim.layers[0];
  assert.equal(record.generation, 'view-1');
  assert.equal(record.state, 'matched');
  assert.equal(new URL(record.response.source).searchParams.get('BBOX'), '30,120,31,121');
  await gateway.frames.flush();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test('地图版本不可回查时拒绝用当前画面代替', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-'));
  const source = await startSource({ scenario: 'transition' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    // view-1 was never observed, and the source has already moved to view-2.
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });
    const { status, body } = await claim(app, 'click-1');
    assert.equal(status, 409);
    assert.match(body.error, /不能改用当前画面/);
    assert.equal((await app.catalog.list()).length, 0);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});
