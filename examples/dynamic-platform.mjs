export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/users/')) {
      const userWorkerName = url.pathname.split('/')[2];
      if (!userWorkerName) return new Response('missing user worker', { status: 400 });
      return env.DISPATCHER.get(userWorkerName).fetch(request);
    }

    const worker = env.LOADER.load({
      compatibilityDate: '2026-05-11',
      mainModule: 'index.js',
      modules: {
        'index.js': `
          export default {
            fetch() {
              return new Response("hello from a dynamic Worker");
            },
          };
        `,
      },
      globalOutbound: null,
    });

    return worker.getEntrypoint().fetch(request);
  },
};
