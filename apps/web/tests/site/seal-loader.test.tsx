import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Loading, SealLoader } from '../../src/components/seal-loader';
import { Button } from '../../src/components/ui/button';
import { sealGeometry } from '../../src/lib/seal';

const rings = (html: string) => html.match(/class="sl-ring"/g)?.length ?? 0;
const HASH = '61f7c958a9efa06bc4c671fb59e6a173ae268a7f454afd56608062ce48fc2bff';

describe('seal loader', () => {
  it('is decorative and draws fewer, heavier rings as it gets smaller', () => {
    const small = renderToStaticMarkup(<SealLoader size={16} />);
    expect(small).toContain('aria-hidden="true"');
    expect(small).not.toContain('role=');
    expect(rings(small)).toBe(2);
    expect(rings(renderToStaticMarkup(<SealLoader size={40} />))).toBe(3);
    const large = renderToStaticMarkup(<SealLoader size={96} />);
    expect(rings(large)).toBe(5);
    expect(large).toContain('vector-effect="non-scaling-stroke"');
  });

  it('turns in small places and forms in large ones', () => {
    const small = renderToStaticMarkup(<SealLoader size={16} />);
    expect(small).toContain('data-motion="turn"');
    expect(small.match(/data-ccw/g)?.length).toBe(1);
    expect(renderToStaticMarkup(<SealLoader size={32} />)).toContain('data-motion="form"');
    expect(renderToStaticMarkup(<SealLoader size={32} />)).not.toContain('data-ccw');
  });

  it('forms from the centre out: the innermost ring is drawn first, every arc by a unit-length dash', () => {
    const html = renderToStaticMarkup(<SealLoader size={96} />);
    const order = [...html.matchAll(/class="sl-ring" style="--i:(\d)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([4, 3, 2, 1, 0]);
    expect(html.match(/class="sl-arc"/g)!.length).toBe(html.match(/pathLength="1"/g)!.length);
  });

  it('says what is loading, politely, in every layout', () => {
    for (const layout of ['inline', 'block', 'page'] as const) {
      const html = renderToStaticMarkup(<Loading layout={layout} label="Loading agents…" />);
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('Loading agents…');
    }
  });

  it('a busy button is disabled, marked busy and turns the seal before its words', () => {
    const html = renderToStaticMarkup(<Button busy>Saving…</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html.indexOf('seal-loader')).toBeLessThan(html.indexOf('Saving…'));
    expect(renderToStaticMarkup(<Button>Save</Button>)).not.toContain('seal-loader');
  });

  it('wider breaks shorten arcs without moving the rings', () => {
    const a = sealGeometry(HASH);
    const b = sealGeometry(HASH, 3.2);
    expect(b.outline).toBe(a.outline);
    expect(new Set(b.arcs.map((x) => x.ring))).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('keeps still under reduced motion and only breathes', () => {
    const css = readFileSync(join(import.meta.dir, '../../src/app/globals.css'), 'utf8');
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.seal-loader \.sl-ring \{\s*animation: sl-breathe[^}]*!important/);
    const breathe = reduce.slice(reduce.indexOf('@keyframes sl-breathe'));
    expect(breathe.slice(0, breathe.indexOf('}') + 1)).not.toMatch(/transform|rotate|scale/);
  });
});
