// Netlify adapter for the Vercel-style game API handler in api/game/[action].js.
// netlify.toml rewrites /api/game/:action to this function with ?action=:action.
const handler = require('../../api/game/[action].js');

exports.handler = async (event) => {
  let body = {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body;
    body = raw ? JSON.parse(raw) : {};
  } catch (e) { /* leave empty; the handler validates fields */ }

  const req = {
    method: event.httpMethod,
    headers: event.headers || {},
    query: { action: (event.queryStringParameters || {}).action },
    body,
  };

  return new Promise((resolve) => {
    const res = {
      _code: 200,
      status(code) { this._code = code; return this; },
      json(obj) {
        resolve({ statusCode: this._code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
      },
    };
    Promise.resolve(handler(req, res)).catch((e) => {
      console.error(e);
      resolve({ statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Something went wrong' }) });
    });
  });
};
