/**
 * A creation step's number inside a drawn ring. Working: a short arc travels slowly around it. Asking: the ring
 * turns wax and a ripple leaves it every couple of seconds (reduced motion: it breathes in place), so the person's turn
 * never looks like a stall. Done: the ring closes and gives way to a check. Motion lives in globals.css (.ring-*)
 * and stops under prefers-reduced-motion.
 */
export type RingState = 'idle' | 'working' | 'asking' | 'done';

export function StepRing({ state, n }: { state: RingState; n: number }) {
  return (
    <span aria-hidden="true" data-ring={state} className={`ring-${state} relative grid h-[30px] w-[30px] shrink-0 place-items-center`}>
      <svg viewBox="0 0 30 30" className="absolute inset-0 h-full w-full">
        <circle className="ring-track" cx="15" cy="15" r="14" />
        {state !== 'idle' ? <circle className="ring-draw" cx="15" cy="15" r="14" transform="rotate(-90 15 15)" /> : null}
        {state === 'done' ? (
          <>
            <circle className="ring-fill" cx="15" cy="15" r="14.5" />
            <path data-tick="" className="ring-tick" d="M9.5 15.5l3.5 3.5 7.5-8" />
          </>
        ) : null}
      </svg>
      {state === 'asking' ? <span data-halo="" className="ring-halo" /> : null}
      {state === 'done' ? null : <span className="relative text-xs font-semibold">{n}</span>}
    </span>
  );
}
