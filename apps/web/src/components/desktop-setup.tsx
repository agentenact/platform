'use client';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '@/components/copy-button';
import { copy } from '@/copy';
import { KEY_PLACEHOLDER } from '@/lib/connect-config';
import { DESKTOP_APPS, SERVER_NAME, maskKey, type DesktopApp, type Scene } from '@/lib/desktop-setup';

const c = copy.connect;
/** How long each step stays on screen while the sketch plays. */
const STEP_MS = 4200;

/**
 * "In a desktop app": one tab per app, a sketch of its window that plays the steps in turn, and the steps as a list you
 * can tap. The sketch is drawn in Night (no copy of the app's own look). It plays only while on screen, stops while the
 * pointer or focus is inside, and never plays under reduced motion: then each tap shows a still, finished step.
 */
export function DesktopSetup({ apiKey }: { apiKey: string }) {
  const [appId, setAppId] = useState<DesktopApp['id']>(DESKTOP_APPS[0]!.id);
  const [step, setStep] = useState(0);
  const [held, setHeld] = useState(false);
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const app = DESKTOP_APPS.find((a) => a.id === appId)!;
  const playing = visible && !held && !still;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    const el = root.current;
    const seen = el ? new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { threshold: 0.35 }) : null;
    if (el && seen) seen.observe(el);
    return () => {
      mq.removeEventListener('change', sync);
      seen?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % app.steps.length), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, app.steps.length]);

  const pick = (id: DesktopApp['id']) => {
    setAppId(id);
    setStep(0);
  };
  const current = app.steps[step]!;

  return (
    <div
      ref={root}
      className="space-y-4"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <div role="tablist" aria-label={c.desktopTitle} className="ds-tabs">
        {DESKTOP_APPS.map((a) => (
          <button key={a.id} type="button" role="tab" id={`ds-tab-${a.id}`} aria-selected={a.id === appId} aria-controls="ds-panel" data-ds-tab={a.id} onClick={() => pick(a.id)}>
            {a.label}
          </button>
        ))}
      </div>

      <div id="ds-panel" role="tabpanel" aria-labelledby={`ds-tab-${app.id}`} className="space-y-4">
        <figure className="ds-window" aria-hidden="true" data-playing={playing ? '' : undefined}>
          <div className="ds-bar">
            <i />
            <i />
            <i />
            <span>{app.window}</span>
          </div>
          <div className="ds-stage" key={`${app.id}-${step}`}>
            <SceneView scene={current.scene} app={app} apiKey={apiKey} />
          </div>
          <div className="ds-progress">
            {app.steps.map((s, i) => (
              <span key={s.title} data-on={i === step ? '' : undefined} data-done={i < step ? '' : undefined} style={{ ['--ds-ms' as string]: `${STEP_MS}ms` }} />
            ))}
          </div>
        </figure>

        <ol className="ds-steps">
          {app.steps.map((s, i) => (
            <li key={s.title} data-on={i === step ? '' : undefined}>
              <button type="button" aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
                <span className="ds-n">{i + 1}</span>
                <span>{s.title}</span>
              </button>
              {i === step && s.paste && !(s.pasteLabel === 'Key' && apiKey === KEY_PLACEHOLDER) ? (
                <div data-advanced="" className="ds-paste">
                  <span className="ds-paste-label">{s.pasteLabel}</span>
                  <code>{s.pasteLabel === 'Key' ? apiKey : s.paste(apiKey)}</code>
                  <CopyButton text={s.paste(apiKey)} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {app.note ? <p className="text-sm text-fg-3">{app.note}</p> : null}
        {app.fallback ? (
          <details className="card ds-fallback">
            <summary>
              {app.fallback.title} <span className="text-fg-3">{app.fallback.where}</span>
            </summary>
            <div data-advanced="" className="mt-3 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-bg p-3 font-mono text-[12.5px] leading-relaxed">{app.fallback.lines(apiKey)}</pre>
              <CopyButton text={app.fallback.lines(apiKey)} />
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** One still frame per step; its parts rise in turn (CSS delays), and under reduced motion they are simply there. */
function SceneView({ scene, app, apiKey }: { scene: Scene; app: DesktopApp; apiKey: string }) {
  const key = maskKey(apiKey);
  const fill = (v: string) => v.replace('{key}', key);
  switch (scene.kind) {
    case 'chat':
      return (
        <div className="ds-chat">
          <p className="ds-bubble ds-you ds-type">{scene.text}</p>
          <p className="ds-bubble ds-them ds-rise" style={{ ['--d' as string]: '2.2s' }}>
            Adding {SERVER_NAME}. I need your key: opening a secret card.
          </p>
        </div>
      );
    case 'secret':
      return (
        <div className="ds-center">
          <div className="ds-card ds-rise">
            <p className="ds-card-title">Secret for {SERVER_NAME}</p>
            <p className="ds-field">
              <span className="ds-mask ds-type" style={{ ['--d' as string]: '0.5s' }}>
                ••••••••••••••••••••
              </span>
            </p>
            <span className="ds-btn ds-press" style={{ ['--d' as string]: '2s' }}>
              Save
            </span>
          </div>
          <p className="ds-ok ds-rise" style={{ ['--d' as string]: '2.8s' }}>
            {SERVER_NAME} · connected
          </p>
        </div>
      );
    case 'ask':
      return (
        <div className="ds-chat">
          <p className="ds-bubble ds-you ds-type">What did my agent do today?</p>
          <p className="ds-tool ds-rise" style={{ ['--d' as string]: '1.2s' }}>
            {SERVER_NAME} · get_activity
          </p>
          <p className="ds-bubble ds-them ds-rise" style={{ ['--d' as string]: '2s' }}>
            XLM buy-the-dip alert checked XLM 23 times today and stayed quiet.
          </p>
        </div>
      );
    case 'menu':
      return (
        <div className="ds-split">
          <ul className="ds-side">
            {scene.path.map((p, i) => (
              <li key={p} className="ds-press" data-pick="" style={{ ['--d' as string]: `${0.5 + i * 0.8}s` }}>
                {p}
              </li>
            ))}
            <li>Chats</li>
            <li>Projects</li>
          </ul>
          <div className="ds-main">
            <p className="ds-card-title ds-rise" style={{ ['--d' as string]: '1.6s' }}>
              Connectors
            </p>
            <span className="ds-btn ds-press ds-rise" style={{ ['--d' as string]: '2.2s' }}>
              {scene.button}
            </span>
          </div>
        </div>
      );
    case 'form':
      return (
        <div className="ds-center">
          <div className="ds-card">
            <p className="ds-card-title">{app.id === 'claude' ? 'Add custom connector' : app.window}</p>
            {scene.fields.map((f, i) => (
              <div key={f.label} className="ds-row ds-rise" style={{ ['--d' as string]: `${0.3 + i * 0.7}s` }}>
                <span className="ds-label">{f.label}</span>
                <span className="ds-field ds-mono">{fill(f.value)}</span>
              </div>
            ))}
            <span className="ds-btn ds-press" style={{ ['--d' as string]: `${0.6 + scene.fields.length * 0.7}s` }}>
              {scene.button}
            </span>
          </div>
        </div>
      );
    case 'file':
      return (
        <div className="ds-editor">
          <p className="ds-path">{scene.path}</p>
          {scene.lines.map((l, i) => (
            <p key={l} className="ds-mono ds-rise" style={{ ['--d' as string]: `${0.4 + i * 0.7}s` }}>
              <span className="ds-ln">{i + 1}</span>
              {fill(l)}
            </p>
          ))}
        </div>
      );
    case 'servers':
      return (
        <div className="ds-split">
          <ul className="ds-side">
            <li>General</li>
            <li className="ds-press" data-pick="" style={{ ['--d' as string]: '0.4s' }}>
              MCP servers
            </li>
            <li>Appearance</li>
          </ul>
          <div className="ds-main">
            <div className="ds-row ds-rise" style={{ ['--d' as string]: '1s' }}>
              <span className="ds-mono">{SERVER_NAME}</span>
              <span className="ds-label">Streamable HTTP</span>
            </div>
            <span className="ds-btn ds-press ds-rise" style={{ ['--d' as string]: '1.8s' }}>
              {scene.button}
            </span>
            <p className="ds-ok ds-rise" style={{ ['--d' as string]: '2.8s' }}>
              {SERVER_NAME} · connected
            </p>
          </div>
        </div>
      );
  }
}
