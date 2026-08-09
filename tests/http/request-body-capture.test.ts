/// <reference types="node" />

import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  createRequestBodyCapture,
  createRequestBodyCaptureTransform
} from '../../src/http/request-body-capture.js';

async function transformChunks(
  transform: NodeJS.ReadWriteStream,
  chunks: readonly Buffer[]
): Promise<Buffer[]> {
  const forwarded: Buffer[] = [];
  transform.on('data', (chunk: Buffer) => {
    forwarded.push(chunk);
  });
  for (const chunk of chunks) {
    transform.write(chunk);
  }
  transform.end();
  await once(transform, 'end');
  return forwarded;
}

test('request body capture appends in order and counts UTF-8 bytes', () => {
  const capture = createRequestBodyCapture(32);
  capture.append(Buffer.from('甲', 'utf8'));
  capture.append(Buffer.from('乙🙂', 'utf8'));

  const result = capture.result();
  assert.equal(result.status, 'complete');
  assert.equal(result.byteLength, Buffer.byteLength('甲乙🙂', 'utf8'));
  assert.equal(result.body.toString('utf8'), '甲乙🙂');
});

test('request body capture keeps an exact-budget payload complete', () => {
  const capture = createRequestBodyCapture(8);
  capture.append(Buffer.from('1234'));
  capture.append(Buffer.from('5678'));

  const result = capture.result();
  assert.deepEqual(result, {
    status: 'complete',
    body: Buffer.from('12345678'),
    byteLength: 8
  });
});

test('request body capture discards every stored byte over budget and keeps counting', () => {
  const capture = createRequestBodyCapture(8);
  capture.append(Buffer.from('12345678'));
  capture.append(Buffer.from('9'));
  capture.append(Buffer.from('more'));

  assert.deepEqual(capture.result(), {
    status: 'unavailable',
    byteLength: 13
  });
});

test('request body capture release is idempotent and append cannot restart capture', () => {
  const capture = createRequestBodyCapture(32);
  capture.append(Buffer.from('before'));
  capture.release();
  capture.release();
  capture.append(Buffer.from('after'));

  assert.deepEqual(capture.result(), {
    status: 'released',
    byteLength: Buffer.byteLength('before', 'utf8')
  });
});

test('request body capture result does not expose mutable internal storage', () => {
  const capture = createRequestBodyCapture(32);
  capture.append(Buffer.from('immutable'));
  const first = capture.result();
  assert.equal(first.status, 'complete');
  first.body.fill(0);

  const second = capture.result();
  assert.equal(second.status, 'complete');
  assert.equal(second.body.toString('utf8'), 'immutable');
  assert.notEqual(second.body, first.body);
});

test('request body capture transform observes and forwards chunks byte-for-byte in order', async () => {
  const capture = createRequestBodyCapture(64);
  const transform = createRequestBodyCaptureTransform(capture);
  const chunks = [Buffer.from('first-'), Buffer.from('第二'), Buffer.from('-last')];

  const forwarded = await transformChunks(transform, chunks);

  assert.equal(Buffer.concat(forwarded).equals(Buffer.concat(chunks)), true);
  assert.equal(forwarded.length, chunks.length);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(forwarded[index], chunk);
  }
  const result = capture.result();
  assert.equal(result.status, 'complete');
  assert.equal(result.body.equals(Buffer.concat(chunks)), true);
  assert.equal(result.byteLength, Buffer.concat(chunks).byteLength);
});

test('request body capture transform forwards the original chunk when capture throws', async () => {
  const failure = new Error('capture unavailable');
  const throwingCapture = {
    append(): never {
      throw failure;
    },
    release(): void {},
    result(): { status: 'unavailable'; byteLength: number } {
      return { status: 'unavailable', byteLength: 0 };
    }
  };
  const transform = createRequestBodyCaptureTransform(throwingCapture);
  const chunks = [Buffer.from('unchanged-one'), Buffer.from('unchanged-two')];

  const forwarded = await transformChunks(transform, chunks);

  assert.equal(Buffer.concat(forwarded).equals(Buffer.concat(chunks)), true);
  assert.equal(forwarded.length, chunks.length);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(forwarded[index], chunk);
  }
});
