import app from './app.js';

export default {
  fetch: app.fetch.bind(app),
  port: Number(process.env.PORT ?? 3005),
  idleTimeout: 0,
};
