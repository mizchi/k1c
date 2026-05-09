// Minimal Durable Object class paired with statefulset-durable-object.yaml.

export class Counter {
  constructor(state, _env) {
    this.state = state;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const op = url.searchParams.get('op') ?? 'incr';
    let value = (await this.state.storage.get('value')) ?? 0;
    if (op === 'incr') value += 1;
    if (op === 'decr') value -= 1;
    await this.state.storage.put('value', value);
    return Response.json({ value });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') ?? 'default';
    const stub = env.Counter.get(env.Counter.idFromName(id));
    return stub.fetch(req);
  },
};
