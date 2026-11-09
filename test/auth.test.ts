import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, isPasswordHash, verifyPassword } from '../src/auth.ts';

test('passwords are salted with scrypt and verified without storing the password', async () => {
  const password = 'a test passphrase for hashing';
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second); assert.ok(isPasswordHash(first)); assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect password', first), false);
  assert.equal(await verifyPassword(undefined, first), false);
  assert.equal(await verifyPassword('x'.repeat(1025), first), false);
  assert.equal(await verifyPassword(password, 'invalid hash'), false);
  await assert.rejects(() => hashPassword('too short'));
});
