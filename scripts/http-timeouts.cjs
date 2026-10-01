// Preloaded with NODE_OPTIONS for the web container. Node's default 5-minute requestTimeout
// closes multi-GB video uploads that take longer than that to arrive.
const http = require('node:http');

const createServer = http.createServer;
http.createServer = function patchedCreateServer(...args) {
  const server = createServer.apply(this, args);
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 65_000;
  return server;
};
