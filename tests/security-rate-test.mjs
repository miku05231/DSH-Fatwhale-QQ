import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowed, RateLimiter } from '../src/security.js';

test('private blacklist policy never grants unlisted group members admission', () => {
  const config = { security: { privatePolicy: 'blacklist', allowFrom: [1000000002], denyFrom: [1000000004] } };
  assert.equal(isAllowed(1000000003, config), true);
  assert.equal(isAllowed(1000000003, config, { isGroup: true }), false);
  assert.equal(isAllowed('1000000002', config, { isGroup: true }), true);
  assert.equal(isAllowed(1000000004, config), false);
  assert.equal(isAllowed(1000000004, config, { isGroup: true }), false);
  assert.equal(isAllowed(1000000003, { security: { ...config.security, allowFrom: [] } }, { isGroup: true }), false);
});

test('inactive rate-limit keys expire without resetting an active user quota', () => {
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    const limiter = new RateLimiter({ perMinute: 2 });
    for (let i = 0; i < 5001; i++) assert.equal(limiter.take(`inactive-${i}`), true);
    now += 59000;
    assert.equal(limiter.take('active'), true);
    now += 1000;
    assert.equal(limiter.take('active'), true);
    assert.equal(limiter.hits.size, 1);
    assert.equal(limiter.take('active'), false);
    now += 60000;
    assert.equal(limiter.take('new-user'), true);
    assert.equal(limiter.hits.has('active'), false);
    assert.equal(limiter.hits.size, 1);
    assert.equal(limiter.take('inactive-0'), true);
  } finally { Date.now = originalNow; }
});
