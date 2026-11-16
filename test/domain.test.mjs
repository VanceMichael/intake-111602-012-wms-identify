import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('地图查询支持层与空命中不同，版本决定像素参数', async () => {
  const source = await startSource();
  try {
    const client = new SourceClient(source.base);
    const query = '/wms?REQUEST=GetFeatureInfo&VERSION=1.3.0&QUERY_LAYERS=fire:hydrants';
    assert.equal((await client.request(query + '&X=400&Y=300')).status, 400);
    const hit = JSON.parse((await client.request(query + '&I=400&J=300')).bytes);
    assert.equal(hit.features.length, 1);
    const empty = JSON.parse((await client.request(query + '&I=1&J=1')).bytes);
    assert.equal(empty.features.length, 0);
    const unsupported = await client.request('/wms?REQUEST=GetFeatureInfo&VERSION=1.3.0&QUERY_LAYERS=fire:access&I=1&J=1');
    assert.equal(unsupported.status, 400);
  } finally { await source.close(); }
});
