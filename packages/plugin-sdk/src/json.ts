import type { Json } from '../../protocol/src/index.ts';
/** JSON transport values cannot carry executable getters, functions, cycles or class instances. */
export function assertJson(value: unknown, path = 'value', seen = new Set<object>()): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new TypeError(`${path} must be plain JSON`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError(`${path} cannot contain symbol keys`);
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in property) || !property.enumerable) throw new TypeError(`${path}.${key} cannot contain accessors`);
    assertJson(property.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
