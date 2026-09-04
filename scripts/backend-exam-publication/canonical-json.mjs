import { createHash } from 'node:crypto';

/**
 * Canonical JSON contract for protected publication hashing:
 * - object keys are sorted by JavaScript's deterministic UTF-16 code-unit order;
 * - array order and string contents are preserved;
 * - only JSON null, booleans, strings, and finite non-negative-zero numbers are accepted;
 * - only ordinary Object.prototype objects with enumerable data properties are accepted.
 *
 * Ambiguous JavaScript values are rejected instead of being dropped or coerced.
 */
export function canonicalSerialize(value) {
  return serializeValue(value, '$', new Set());
}

export function sha256Canonical(value) {
  return createHash('sha256')
    .update(canonicalSerialize(value), 'utf8')
    .digest('hex');
}

function serializeValue(value, path, activeObjects) {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`Unsupported number at ${path}.`);
    }

    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported ${typeof value} at ${path}.`);
  }

  if (activeObjects.has(value)) {
    throw new TypeError(`Cyclic value at ${path}.`);
  }

  activeObjects.add(value);

  try {
    if (Array.isArray(value)) {
      return serializeArray(value, path, activeObjects);
    }

    return serializePlainObject(value, path, activeObjects);
  } finally {
    activeObjects.delete(value);
  }
}

function serializeArray(value, path, activeObjects) {
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);

  if (
    ownKeys.some((key) => typeof key === 'symbol' || !expectedKeys.has(key)) ||
    value.some((_, index) => !Object.hasOwn(value, index)) ||
    Object.keys(value).length !== value.length
  ) {
    throw new TypeError(`Sparse or decorated array at ${path}.`);
  }

  return `[${value
    .map((item, index) => serializeValue(item, `${path}[${index}]`, activeObjects))
    .join(',')}]`;
}

function serializePlainObject(value, path, activeObjects) {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Non-plain object at ${path}.`);
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`Symbol-keyed property at ${path}.`);
  }

  const propertyNames = Object.getOwnPropertyNames(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const propertyName of propertyNames) {
    const descriptor = descriptors[propertyName];

    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`Non-data or non-enumerable property at ${path}.${propertyName}.`);
    }
  }

  const keys = [...propertyNames].sort();
  const entries = keys.map((key) => (
    `${JSON.stringify(key)}:${serializeValue(value[key], `${path}.${key}`, activeObjects)}`
  ));

  return `{${entries.join(',')}}`;
}
