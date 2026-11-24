import plugin from '../../dist/index.mjs';
await plugin({}, JSON.parse(process.env.TEST_PLUGIN_OPTIONS || '{}'));
setInterval(() => {}, 1000);
