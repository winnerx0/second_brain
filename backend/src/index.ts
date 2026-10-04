import app, { websocket } from './app.js';

export default {
  fetch: app.fetch.bind(app),
  websocket,
  port: Number(process.env.PORT ?? 3005),
  idleTimeout: 0,
};
