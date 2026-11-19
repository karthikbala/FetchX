import document from '../../../docs/openapi.json' with { type: 'json' };

type Reference = { $ref: string };
type Schema = {
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, Schema | Reference>;
  required?: string[];
  anyOf?: (Schema | Reference)[];
  oneOf?: (Schema | Reference)[];
  allOf?: (Schema | Reference)[];
  items?: Schema | Reference;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};
type Media = {
  schema: Schema | Reference;
  examples?: Record<string, { value: unknown }>;
};
type Body = { content: Record<string, Media> };
type Response = { description: string; content?: Body['content'] };
type Parameter = {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema: Schema | Reference;
};
type Method = 'get' | 'post';
type Operation = {
  operationId: string;
  summary: string;
  description?: string;
  'x-managed-key-scope': string;
  requestBody?: Body | Reference;
  parameters?: (Parameter | Reference)[];
  responses: Record<string, Response | Reference>;
};
type Contract = { paths: Record<string, Partial<Record<Method, Operation>>> };

export const openApiDocument = document;
const contract = document as unknown as Contract;

function resolve<T extends object>(value: T | Reference): T {
  if (!('$ref' in value)) return value as T;
  const pointer = value.$ref;
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) {
    throw new Error('Expected a local reference in the FetchX OpenAPI document');
  }
  let node: unknown = document;
  for (const part of pointer.slice(2).split('/')) {
    const name = part.replaceAll('~1', '/').replaceAll('~0', '~');
    node = (node as Record<string, unknown> | undefined)?.[name];
  }
  if (!node || typeof node !== 'object') throw new Error(`OpenAPI reference not found: ${pointer}`);
  return resolve(node as T | Reference);
}

export const contractOperations = Object.entries(contract.paths).flatMap(([path, methods]) =>
  (['get', 'post'] as const).flatMap(method => {
    const operation = methods[method];
    return operation ? [{
      ...operation,
      path,
      method: method.toUpperCase() as Uppercase<Method>,
      scope: operation['x-managed-key-scope'],
    }] : [];
  }),
);
type ContractOperation = (typeof contractOperations)[number];

export function contractOperation(id: string): ContractOperation {
  const operation = contractOperations.find(item => item.operationId === id);
  if (!operation) throw new Error(`OpenAPI operation not found: ${id}`);
  return operation;
}

function requestMedia(operation: ContractOperation): Media {
  const media = operation.requestBody && resolve<Body>(operation.requestBody).content['application/json'];
  if (!media) throw new Error(`Missing JSON request for ${operation.operationId}`);
  return media;
}

function responseMedia(operation: ContractOperation, status: string): Media {
  const response = operation.responses[status];
  const media = response && resolve<Response>(response).content?.['application/json'];
  if (!media) throw new Error(`Missing JSON response for ${operation.operationId}: ${status}`);
  return media;
}

function requiredExample(media: Media, name = 'example'): unknown {
  const example = media.examples?.[name];
  if (!example) throw new Error(`Missing example in the FetchX OpenAPI document: ${name}`);
  return example.value;
}

export function requestExample(operation: ContractOperation) {
  return requiredExample(requestMedia(operation)) as { idempotency_key: string };
}

export function responseExample(operation: ContractOperation, name?: string) {
  return requiredExample(responseMedia(operation, '200'), name);
}

function fieldType(value: Schema | Reference): string {
  const schema = resolve<Schema>(value);
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) return [...new Set(alternatives.map(fieldType))].join(' or ');
  if (schema.type === 'array' && schema.items) return `array of ${fieldType(schema.items)}`;
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  if (schema.type && schema.format) return `${schema.type} (${schema.format})`;
  return schema.type ?? (schema.properties || schema.allOf ? 'object' : 'JSON value');
}

function objectFields(value: Schema | Reference): Record<string, { schema: Schema | Reference; required: boolean }> {
  const schema = resolve<Schema>(value);
  const branches = (schema.oneOf ?? schema.anyOf ?? []).map(objectFields).filter(fields => Object.keys(fields).length);
  const commonFields = Object.fromEntries([...new Set(branches.flatMap(Object.keys))].map(name => {
    const choices = branches.map(fields => fields[name]).filter(Boolean);
    return [name, {
      schema: choices.length === 1 ? choices[0].schema : { anyOf: choices.map(choice => choice.schema) },
      required: branches.every(fields => fields[name]?.required),
    }];
  }));
  return {
    ...Object.assign({}, ...(schema.allOf ?? []).map(objectFields)),
    ...commonFields,
    ...Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => [
      name, { schema: property, required: schema.required?.includes(name) ?? false },
    ])),
  };
}

function constraints(value: Schema | Reference): string {
  const schema = resolve<Schema>(value);
  const code = (item: unknown) => '`' + JSON.stringify(item) + '`';
  const choices = (item: Schema | Reference): unknown[] => {
    const shape = resolve<Schema>(item);
    return shape.enum ?? (Object.hasOwn(shape, 'const') ? [shape.const] : []);
  };
  const allowed = (schema.oneOf ?? schema.anyOf ?? [value]).flatMap(choices);
  const messages: string[] = [];
  if (allowed.length) messages.push('Allowed values are ' + allowed.map(code).join(', ') + '.');
  if (Object.hasOwn(schema, 'default')) messages.push('Default is ' + code(schema.default) + '.');
  if (schema.minimum !== undefined) messages.push('Minimum ' + code(schema.minimum) + '.');
  if (schema.maximum !== undefined) messages.push('Maximum ' + code(schema.maximum) + '.');
  if (schema.minLength !== undefined) messages.push('Minimum length ' + code(schema.minLength) + '.');
  if (schema.maxLength !== undefined) messages.push('Maximum length ' + code(schema.maxLength) + '.');
  if (schema.pattern) messages.push('Matches `' + schema.pattern + '`.');
  return messages.join(' ');
}

function fieldRows(value: Schema | Reference, nested: string[], includeConstraints = false, prefix = ''): string[][] {
  return Object.entries(objectFields(value)).flatMap(([name, { schema, required }]) => {
    const path = prefix + name;
    const description = ('description' in schema ? schema.description : undefined) ?? resolve<Schema>(schema).description ?? '';
    const details = includeConstraints ? [description, constraints(schema)].filter(Boolean).join(' ') : description;
    const row = [`\`${path}\``, fieldType(schema), required ? 'Yes' : 'No', details];
    return nested.includes(name) ? [row, ...fieldRows(schema, [], includeConstraints, path + '.')] : [row];
  });
}

export function requestRows(operation: ContractOperation): string[][] {
  return fieldRows(requestMedia(operation).schema, ['access_profile', 'proxy'], true);
}

export function responseRows(operation: ContractOperation, nested: string[] = []): string[][] {
  return fieldRows(responseMedia(operation, '200').schema, nested).map(
    ([field, type, , description]) => [field, type, description],
  );
}

export function parameterRows(operation: ContractOperation): string[][] {
  return (operation.parameters ?? []).map(reference => {
    const parameter = resolve<Parameter>(reference);
    return [
      '`' + parameter.name + '`', parameter.in, fieldType(parameter.schema),
      parameter.required ? 'Yes' : 'No',
      [parameter.description, constraints(parameter.schema)].filter(Boolean).join(' '),
    ];
  });
}

export function statusRows(operation: ContractOperation): string[][] {
  return Object.entries(operation.responses).map(([status, response]) => [
    `\`${status}\``, resolve<Response>(response).description,
  ]);
}
