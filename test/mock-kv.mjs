// In-memory stand-in for a Workers KV namespace, for local tests only.
export function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) };
    },
  };
}
