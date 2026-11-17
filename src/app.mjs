import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { OperationGateway } from './operation.mjs';
import { profile } from './profile.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  return value;
}

function reply(response, status, value) {
  response.statusCode = status;
  return response.end(JSON.stringify(value));
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const gateway = new OperationGateway({ source: new SourceClient(source), catalog, root });

  async function claimReceipt(operation, input) {
    const layers = Array.isArray(input.layers) ? input.layers
      : Array.isArray(input.queryLayers) ? input.queryLayers
        : input.layer !== undefined ? [input.layer] : undefined;
    const claim = await gateway.claim(String(operation), { layers });
    return catalog.accept({
      source: claim.source,
      bytes: Buffer.from(JSON.stringify(claim.map, null, 2)),
      mediaType: 'application/json',
      preview: claim.map,
      map: claim.map,
      context: claim.context,
      kind: 'map-operation',
      operation: claim.operation,
      requestVersion: claim.requestVersion,
      requestBbox: claim.requestBbox,
      versionMismatch: claim.versionMismatch,
      scope: claim.scope,
      scopeNote: claim.scopeNote,
      capabilities: claim.capabilities,
      layers: claim.layers,
      summary: claim.summary,
    });
  }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return reply(response, 200, { ready: true, product: profile.name });
      if (request.method === 'GET' && url.pathname === '/preview') {
        const path = url.searchParams.get('path');
        if (path) {
          const result = await previewOne(source, path);
          return reply(response, 200, { source: result.url, preview: result.preview });
        }
        // Observing the map here also keeps the frame available when a later
        // claim refers to an operation issued against this view.
        const observed = await gateway.context();
        return reply(response, 200, { source: observed.url, preview: observed.context });
      }
      if (request.method === 'GET' && url.pathname === '/operations') {
        await gateway.observe();
        return reply(response, 200, await gateway.operations());
      }
      const operationClaim = /^\/operations\/([^/]+)\/receipts$/.exec(url.pathname);
      if (request.method === 'POST' && operationClaim) {
        return reply(response, 201, await claimReceipt(decodeURIComponent(operationClaim[1]), await body(request)));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/operations/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        try {
          return reply(response, 200, await gateway.operationDisplay(id));
        } catch (error) {
          return reply(response, error.status || 422,
            { error: error.status === 404 ? '没有此地图操作' : error.message });
        }
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await body(request);
        const operation = input.operation ?? input.operationId;
        if (operation !== undefined) {
          return reply(response, 201, await claimReceipt(String(operation), input));
        }
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview, kind: 'document' });
        return reply(response, 201, receipt);
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return reply(response, 200, await catalog.list());
      if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
        const receipt = await catalog.get(url.pathname.split('/').at(-1));
        if (!receipt) return reply(response, 404, { error: '没有此凭据' });
        return reply(response, 200, receipt);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      return reply(response, 404, { error: '没有此操作' });
    } catch (error) {
      return reply(response, error.status || 422, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, gateway,
    close: async () => {
      await gateway.frames.flush();
      await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
