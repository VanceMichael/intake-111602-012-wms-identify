function attribute(source, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(source || '');
  return match ? match[2] ?? match[3] : null;
}

function localName(name) {
  return String(name).split(':').at(-1).toLowerCase();
}

function parseXml(source) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  const tokens = source.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g);
  for (const token of tokens) {
    const value = token[0];
    if (token[1] !== undefined) {
      stack.at(-1).text += token[1];
      continue;
    }
    if (value.startsWith('<!--') || value.startsWith('<?') || value.startsWith('<!')) continue;
    if (!value.startsWith('<')) {
      stack.at(-1).text += value;
      continue;
    }
    const closing = /^<\s*\/\s*([A-Za-z_][\w:.-]*)/.exec(value);
    if (closing) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (localName(stack[index].name) === localName(closing[1])) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const opening = /^<\s*([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(value);
    if (!opening) continue;
    const node = { name: opening[1], attributes: opening[2], children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!opening[3]) stack.push(node);
  }
  return root;
}

function find(node, name) {
  for (const child of node.children) {
    if (localName(child.name) === name.toLowerCase()) return child;
    const nested = find(child, name);
    if (nested) return nested;
  }
  return null;
}

function textContent(node) {
  return (node.text + node.children.map(textContent).join('')).trim();
}

function booleanAttribute(value) {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function layerElements(node, inherited = null, result = []) {
  for (const child of node.children) {
    if (localName(child.name) !== 'layer') {
      layerElements(child, inherited, result);
      continue;
    }
    const own = booleanAttribute(attribute(child.attributes, 'queryable'));
    const queryable = own ?? inherited;
    const nameElement = child.children.find(item => localName(item.name) === 'name');
    result.push({ name: nameElement ? textContent(nameElement) : null, queryable });
    layerElements(child, queryable, result);
  }
  return result;
}

export function parseCapabilities(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const tree = parseXml(source);
  const root = find(tree, 'WMS_Capabilities') || find(tree, 'WMT_MS_Capabilities');
  if (!root) throw new Error('来源能力不是 WMS 能力文档');
  const version = attribute(root.attributes, 'version');
  if (!version) throw new Error('来源能力缺少版本');
  const layers = new Map();
  for (const layer of layerElements(root)) {
    if (!layer.name) continue;
    const entries = layers.get(layer.name) || [];
    entries.push(layer.queryable);
    layers.set(layer.name, entries);
  }
  return { version, layers };
}

// true: the source declares the layer queryable, false: it declares it not
// queryable, null: the layer is absent or has no statement inherited anywhere.
export function queryableState(capabilities, name) {
  const entries = capabilities?.layers?.get(name);
  if (!entries || entries.length === 0) return null;
  if (entries.includes(true)) return true;
  if (entries.every(value => value === false)) return false;
  return null;
}
