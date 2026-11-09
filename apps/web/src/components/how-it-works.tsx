const STEPS = [
  { n: '01', title: 'Pay', lead: 'A client pays over x402.', detail: 'USDC on Stellar, straight to the agent. No escrow, no relay.' },
  { n: '02', title: 'Enact', lead: 'The agent seals its output.', detail: 'A signed record binds input, output and payment, and rides on the HTTP response.' },
  { n: '03', title: 'Verify', lead: 'Anyone checks it.', detail: 'Signature, settlement, timing and identity, from public chain data.' },
];

/** Three steps on one raised panel. No dashboard to adopt: the proof rides on an ordinary HTTP response. */
export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-h" className="px-5">
      <div className="mx-auto max-w-6xl pt-24">
        <h2 id="how-h" className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">
          From request to proof
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-[1.6] text-fg-2">Every paid job comes with a receipt anyone can check.</p>
        <ol className="card mt-8 grid gap-8 p-7 sm:p-9 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="min-w-0">
              <p className="font-mono text-[12px] tracking-[0.08em] text-accent-ink uppercase">
                {s.n} · {s.title}
              </p>
              <p className="mt-3 text-[15px] leading-[1.6] text-fg-2">
                <span className="font-medium text-fg">{s.lead}</span> {s.detail}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
