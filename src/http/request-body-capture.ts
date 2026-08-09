import { Transform } from 'node:stream';

export const RAW_REQUEST_BODY_CAPTURE_LIMIT = 1_048_576;

export type RequestBodyCaptureResult =
  | { readonly status: 'complete'; readonly body: Buffer; readonly byteLength: number }
  | { readonly status: 'unavailable'; readonly byteLength: number }
  | { readonly status: 'released'; readonly byteLength: number };

export interface RequestBodyCapture {
  append(chunk: Buffer): void;
  release(): void;
  result(): RequestBodyCaptureResult;
}

export function createRequestBodyCapture(
  limit = RAW_REQUEST_BODY_CAPTURE_LIMIT
): RequestBodyCapture {
  let chunks: Buffer[] = [];
  let byteLength = 0;
  let status: RequestBodyCaptureResult['status'] = 'complete';

  return {
    append(chunk): void {
      if (status === 'released') return;
      try {
        byteLength += chunk.byteLength;
        if (status === 'unavailable') return;
        if (byteLength > limit) {
          status = 'unavailable';
          chunks = [];
          return;
        }
        chunks.push(Buffer.from(chunk));
      } catch {
        status = 'unavailable';
        chunks = [];
      }
    },
    release(): void {
      if (status === 'released') return;
      status = 'released';
      chunks = [];
    },
    result(): RequestBodyCaptureResult {
      if (status === 'complete') {
        return { status, body: Buffer.concat(chunks), byteLength };
      }
      return { status, byteLength };
    }
  };
}

export function createRequestBodyCaptureTransform(
  capture: RequestBodyCapture
): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        capture.append(chunk);
      } catch {
        // Observation failure must not alter the parser stream.
      }
      callback(null, chunk);
    }
  });
}
