import { describe, expect, test } from 'bun:test';
import { bodyChunks, parseSse, type SseFrame } from '../src/lib/sse';

const enc = new TextEncoder();
async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p;
}
const all = async (it: AsyncIterable<SseFrame>) => {
  const out: SseFrame[] = [];
  for await (const f of it) out.push(f);
  return out;
};

describe('parseSse', () => {
  test('parses a frame split across two chunks', async () => {
    const out = await all(parseSse(chunks('event: delta\nda', 'ta: {"text":"he', 'llo"}\n', '\nevent: done\ndata: {"status":"done"}\n\n')));
    expect(out).toEqual([
      { event: 'delta', data: { text: 'hello' } },
      { event: 'done', data: { status: 'done' } },
    ]);
  });
  test('ignores keepalive comments', async () => {
    const out = await all(parseSse(chunks(': keepalive\n\n', 'event: delta\ndata: {"text":"a"}\n\n', ': keepalive\n\n')));
    expect(out).toEqual([{ event: 'delta', data: { text: 'a' } }]);
  });
  test('skips malformed json and continues', async () => {
    const out = await all(parseSse(chunks('event: delta\ndata: {not json\n\n', 'event: delta\ndata: {"text":"ok"}\n\n')));
    expect(out).toEqual([{ event: 'delta', data: { text: 'ok' } }]);
  });
  test('ends cleanly on stream close, delivering a last frame that has no closing blank line', async () => {
    expect(await all(parseSse(chunks()))).toEqual([]);
    expect(await all(parseSse(chunks('event: done\ndata: {"status":"done"}\n')))).toEqual([{ event: 'done', data: { status: 'done' } }]);
    expect(await all(parseSse(chunks('event: delta\ndata: {"te')))).toEqual([]); // cut mid-frame: nothing half-parsed
  });
  test('a multi-byte character split across chunks survives', async () => {
    const bytes = enc.encode('event: delta\ndata: {"text":"proof ↗ é"}\n\n');
    const cut = bytes.indexOf(0xe2) + 1; // inside the arrow
    const out = await all(parseSse(chunks(bytes.slice(0, cut), bytes.slice(cut))));
    expect(out).toEqual([{ event: 'delta', data: { text: 'proof ↗ é' } }]);
  });
  test('handles CRLF line endings and a frame without an event name', async () => {
    const out = await all(parseSse(chunks('data: {"a":1}\r\n\r\nevent: x\r\ndata: {"b":2}\r\n\r\n')));
    expect(out).toEqual([
      { event: 'message', data: { a: 1 } },
      { event: 'x', data: { b: 2 } },
    ]);
  });
});

describe('bodyChunks', () => {
  test('reads a ReadableStream to the end', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: delta\ndata: {"text":"a"}\n\n'));
        c.enqueue(enc.encode('event: done\ndata: {"status":"done"}\n\n'));
        c.close();
      },
    });
    expect((await all(parseSse(bodyChunks(body)))).map((f) => f.event)).toEqual(['delta', 'done']);
  });
});
