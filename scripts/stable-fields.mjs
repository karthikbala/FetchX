// Response fields callers rely on, pinned in docs/stable-fields.json so a
// breaking change to one can't ship without a deprecation (docs/changelog.json
// policy). test/stable-fields.test.mjs compares each pin with the contract.
//
// A field is written from its answer's schema: `FetchResult.attempts[].sign_in`
// is FetchResult's attempts, each item's sign_in. Its shape is the JSON types it
// may have, its enum values (if any) and whether it is always present.
//
//   node scripts/stable-fields.mjs pin FetchResult.attempts[].sign_in ...   pin fields (as the contract has them now)
//   node scripts/stable-fields.mjs check                                    what the test checks, as a list
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const ref = (spec, schema) => {
  let node = schema;
  for (let guard = 0; node?.$ref && guard < 20; guard++) node = node.$ref.slice(2).split('/').reduce((at, key) => at?.[key], spec);
  return node;
};
// A schema's branches: itself, or each of its oneOf/anyOf alternatives, resolved.
const branches = (spec, schema) => {
  const node = ref(spec, schema);
  const alternatives = node?.oneOf ?? node?.anyOf;
  return alternatives ? alternatives.flatMap(entry => branches(spec, entry)) : node ? [node] : [];
};
const typesOf = node => [node.type ?? []].flat();

// The field's shape, or null when the contract has no such field.
export function shapeOf(spec, field) {
  const [root, ...rest] = field.split('.');
  let nodes = branches(spec, {$ref: `#/components/schemas/${root}`});
  if (!nodes.length) return null;
  let required = true;
  for (const part of rest.join('.').split('.')) {
    const many = part.endsWith('[]');
    const name = many ? part.slice(0, -2) : part;
    const parents = nodes.filter(node => node.properties?.[name]);
    if (!parents.length) return null;
    // Present only when every object branch that could hold it requires it.
    required = required && parents.every(node => (node.required ?? []).includes(name));
    nodes = parents.flatMap(node => branches(spec, node.properties[name]));
    if (many) {
      if (!nodes.some(node => typesOf(node).includes('array'))) return null;
      nodes = nodes.filter(node => node.items).flatMap(node => branches(spec, node.items));
    }
  }
  const types = [...new Set(nodes.flatMap(typesOf))].sort();
  const values = nodes.flatMap(node => node.enum ?? []).filter(value => value !== null);
  return {types, ...(values.length ? {enum: [...new Set(values)].sort()} : {}), required};
}

// What is breaking about the field's shape now against its pin: [] when nothing.
export function breaks(pinned, now) {
  if (!now) return ['it is gone (removed or renamed)'];
  const problems = [];
  const added = now.types.filter(type => !pinned.types.includes(type));
  if (added.length) problems.push(`it may now be ${added.join(' or ')}`);
  const dropped = (pinned.enum ?? []).filter(value => !(now.enum ?? []).includes(value));
  if (pinned.enum && !now.enum) problems.push('it lost its list of values');
  else if (dropped.length) problems.push(`values ${dropped.join(', ')} are gone`);
  if (pinned.required && !now.required) problems.push('it is no longer always present');
  return problems;
}

const files = {
  spec: new URL('../docs/openapi.json', import.meta.url),
  pins: new URL('../docs/stable-fields.json', import.meta.url),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...fields] = process.argv.slice(2);
  const spec = JSON.parse(await readFile(files.spec, 'utf8'));
  const pins = JSON.parse(await readFile(files.pins, 'utf8'));
  if (command === 'pin') {
    for (const field of fields) {
      const shape = shapeOf(spec, field);
      if (!shape) throw new Error(`${field} is not in docs/openapi.json`);
      pins.fields[field] = shape;
    }
    pins.fields = Object.fromEntries(Object.entries(pins.fields).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(files.pins, JSON.stringify(pins, null, 2) + '\n');
    console.log(`pinned ${fields.length}; ${Object.keys(pins.fields).length} in all`);
  } else if (command === 'check') {
    for (const [field, pinned] of Object.entries(pins.fields)) {
      const problems = breaks(pinned, shapeOf(spec, field));
      console.log(`${problems.length ? 'BREAKS' : 'ok    '} ${field}${problems.length ? `: ${problems.join('; ')}` : ''}`);
    }
  } else {
    console.error('usage: node scripts/stable-fields.mjs pin FIELD... | check');
    process.exit(2);
  }
}
