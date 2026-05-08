export default {
  async fetch(request, env) {
    const greeting = env.GREETING ?? 'hi';
    return new Response(`${greeting} from ${env.REGION ?? 'somewhere'}\n`, {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
