const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX = '3';
process.env.HEAVY_RATE_LIMIT_MAX = '2';
process.env.MAX_CONCURRENT_JOBS = '2';

const {
  resetThrottlingState,
  globalRateLimit,
  heavyRouteRateLimit,
  limitConcurrentHeavyJobs,
} = require('../server');

const createReq = (ip = '1.1.1.1') => ({
  ip,
  socket: { remoteAddress: ip },
});

const createRes = () => {
  const handlers = {};
  return {
    statusCode: 200,
    body: '',
    headers: {},
    sent: false,
    on(event, cb) {
      handlers[event] = cb;
      return this;
    },
    trigger(event) {
      if (handlers[event]) handlers[event]();
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = String(payload);
      this.sent = true;
      return this;
    },
  };
};

const runMiddleware = (middleware, req) => {
  const res = createRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

test('global limiter blocks after max requests', () => {
  resetThrottlingState();
  const req = createReq('10.0.0.1');

  const first = runMiddleware(globalRateLimit, req);
  const second = runMiddleware(globalRateLimit, req);
  const third = runMiddleware(globalRateLimit, req);
  const fourth = runMiddleware(globalRateLimit, req);

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, true);
  assert.equal(fourth.nextCalled, false);
  assert.equal(fourth.res.statusCode, 429);
  assert.equal(fourth.res.body, 'Too many requests. Please try again later.');
  assert.ok(fourth.res.headers['retry-after']);
});

test('heavy limiter blocks convert-style bursts per IP', () => {
  resetThrottlingState();
  const req = createReq('20.0.0.1');

  const first = runMiddleware(heavyRouteRateLimit, req);
  const second = runMiddleware(heavyRouteRateLimit, req);
  const third = runMiddleware(heavyRouteRateLimit, req);

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body, 'Too many conversion requests. Please wait and retry.');
  assert.ok(third.res.headers['retry-after']);
});

test('concurrency limiter rejects when active jobs exceed cap', () => {
  resetThrottlingState();

  const req1 = createReq('30.0.0.1');
  const req2 = createReq('30.0.0.1');
  const req3 = createReq('30.0.0.1');

  const first = runMiddleware(limitConcurrentHeavyJobs, req1);
  const second = runMiddleware(limitConcurrentHeavyJobs, req2);
  const third = runMiddleware(limitConcurrentHeavyJobs, req3);

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body, 'Server is busy. Please retry shortly.');
  assert.equal(third.res.headers['retry-after'], '10');

  first.res.trigger('finish');

  const fourth = runMiddleware(limitConcurrentHeavyJobs, createReq('30.0.0.1'));
  assert.equal(fourth.nextCalled, true);
});
