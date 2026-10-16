import assert from 'node:assert/strict';
import test from 'node:test';
import { ModalClient } from 'modal';
import { MODAL_SDK_VERSION } from '../src/index.mjs';

test('the exact Modal SDK imports under Node and accepts explicit server credentials', () => {
  const client = new ModalClient({
    tokenId: 'synthetic-id',
    tokenSecret: 'synthetic-secret',
    logLevel: 'error',
  });
  try {
    assert.equal(client.version(), MODAL_SDK_VERSION);
    assert.equal(client.profile.tokenId, 'synthetic-id');
    assert.equal(client.profile.tokenSecret, 'synthetic-secret');
  } finally {
    client.close();
  }
});
