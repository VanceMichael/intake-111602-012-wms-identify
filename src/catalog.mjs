import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Catalog {
  constructor(root) {
    this.root = root;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.root, 'objects'), { recursive: true });
    await mkdir(join(this.root, 'receipts'), { recursive: true });
    return this;
  }

  async atomic(path, bytes) {
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

  async store(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('原始字节不能为空');
    await this.initialize();
    const digest = digestOf(bytes);
    const objectPath = join(this.root, 'objects', digest);
    try {
      const existing = await readFile(objectPath);
      if (!existing.equals(bytes)) throw new Error('内容摘要冲突');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.atomic(objectPath, bytes);
    }
    return { digest, bytes: bytes.length };
  }

  async put(bytes) {
    const operation = this.serial.then(() => this.store(bytes));
    this.serial = operation.catch(() => {});
    return operation;
  }

  async accept({ source, bytes, mediaType, preview, ...metadata }) {
    if (!source || !Buffer.isBuffer(bytes)) throw new TypeError('来源与原始字节不能为空');
    const operation = this.serial.then(async () => {
      const stored = await this.store(bytes);
      const receipt = { id: randomUUID(), source, digest: stored.digest, bytes: stored.bytes,
        mediaType, preview, ...metadata, receivedAt: new Date().toISOString() };
      await this.atomic(join(this.root, 'receipts', `${receipt.id}.json`),
        Buffer.from(JSON.stringify(receipt, null, 2)));
      return receipt;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async list() {
    await this.initialize();
    const files = (await readdir(join(this.root, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.root, 'receipts', name), 'utf8').then(JSON.parse)));
  }

  async get(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的凭据标识');
    try {
      return JSON.parse(await readFile(join(this.root, 'receipts', `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('无效的内容摘要');
    const bytes = await readFile(join(this.root, 'objects', digest));
    if (digestOf(bytes) !== digest) throw new Error('原件校验失败');
    return bytes;
  }
}
