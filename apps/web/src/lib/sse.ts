/**
 * Server-sent events as plain data. Frames are separated by a blank line and may be split across any chunk boundary
 * (a multi-byte character too). Comment lines (": keepalive") are ignored. A frame whose data is not JSON is skipped and
 * the stream carries on. When the stream ends, a last frame without its closing blank line is still delivered.
 */
export interface SseFrame {
  event: string;
  data: unknown;
}

function frameOf(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    return null;
  }
}

export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
      const f = frameOf(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (f) yield f;
    }
  }
  buf += decoder.decode().replace(/\r\n?/g, '\n');
  const last = frameOf(buf);
  if (last) yield last;
}

/** A fetch body as chunks. Reads with a reader, because async iteration over a ReadableStream is not in every browser. */
export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
