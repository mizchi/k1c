export class ChatAgent extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
  }

  async fetch(request) {
    const { prompt = 'Say hello from Cloudflare Agents.' } = await request
      .json()
      .catch(() => ({}));
    const answer = await this.env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct-fast',
      { prompt },
      {
        gateway: {
          id: this.env.AI_GATEWAY_ID,
          collectLog: true,
        },
      },
    );
    return Response.json(answer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, prefix, name = 'default'] = url.pathname.split('/');
    if (prefix !== 'agents') {
      return new Response('POST /agents/<name> with {"prompt":"..."}', { status: 404 });
    }
    const id = env.ChatAgent.idFromName(name);
    return env.ChatAgent.get(id).fetch(request);
  },
};
