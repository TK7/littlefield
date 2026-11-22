// In-memory stand-in for a Workers KV namespace, for local tests only.
export function mockKV() {
  const store = new Map();
  const meta = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts = {}) { store.set(key, String(value)); if (opts.metadata) meta.set(key, opts.metadata); else meta.delete(key); },
    async delete(key) { store.delete(key); meta.delete(key); },
    async list({ prefix = '' } = {}) {
      return { list_complete: true, keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) })) };
    },
  };
}
