/** Permission names constrain SDK calls only; they are not Node process isolation. */
export function assertPluginPermissions(value: unknown): asserts value is string[] {
  const pattern = /^(usage_gateways|eventbox\.(publish|subscribe):[\w.-]+|schedule\.manage|outbox\.enqueue:[\w.-]+|\*|store\.(read|write)|events\.(read|publish|subscribe)|contribute:[\w.-]+|point\.define:[\w.-]+|service\.(provide|use|wrap):[\w.-]+|hook:(work\.dispatch|channel\.send|knowledge\.put))$/;
  if (!Array.isArray(value) || !value.every(permission => typeof permission === 'string' && pattern.test(permission))) throw new TypeError('Unknown SDK permission');
}
