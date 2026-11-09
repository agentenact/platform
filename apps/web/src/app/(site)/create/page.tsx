import type { Metadata } from 'next';
import { CodeBlock } from '@/components/code-block';
import { CreateAgent } from '@/components/create-agent';
import { CreateBuilder } from '@/components/create-builder';
import { CreateSection } from '@/components/create-section';
import { readBuilderParams } from '@/lib/builder';
import { LIBRARY_TEMPLATES } from '@/lib/library-templates';
import { MCP_ON_NPM, OWNER_MCP_CONNECT_URL, OWNER_MCP_LIVE } from '@/lib/mcp';
import { COMMUNITY_HANDLE, COMMUNITY_PUBLISH, IDENTITY, INSTALL, MCP_CLAUDE, MCP_CODEX, MCP_HERMES, MCP_HIRE, MCP_JSON, MCP_TOOLS, OWN_CLAUDE, OWN_CODEX, OWN_GROK, OWN_HERMES, OWN_TOOLS, SERVE, VERIFY, templateSnippet } from '@/lib/snippets';
import { verifierSrc } from '@/lib/verifier-src';
import { AppLink } from '@/components/app-link';

export const metadata: Metadata = {
  title: 'Create an agent — AgentEnact',
  description:
    'Pick a ready agent or describe your own, set its values and try it on real data. Or build it yourself with the library, or in your browser with your own wallet.',
  alternates: { canonical: 'https://agentenact.io/create' },
};

/** `agentenact` is on npm (0.2.0 adds the MCP server; 0.1.0 shipped without dist/, fixed in 0.1.1). */
const ON_NPM = true;

/** The code view's library route, rendered and highlighted here on the server; the builder only shows or hides it. */
function LibrarySections() {
  return (
    <>
      <CreateSection id="install" eyebrow="Library · 1" title="Install">
        {ON_NPM ? null : (
          <p className="card mb-5 border-[var(--caution-edge)] px-4 py-3 text-[14px] text-fg">
            <span className="font-semibold text-[var(--caution)]">Not on npm yet.</span> The name holds a 0.0.1 placeholder, so{' '}
            <code>bun add agentenact</code> installs nothing usable until the release, which is coming. Until then, use the builder or create
            in the browser below.
          </p>
        )}
        <p>
          The core (record and verifier) needs nothing else. Each chain SDK and the x402 packages are optional peers, loaded only by the part
          that needs them.
        </p>
        <CodeBlock code={INSTALL} label="shell" lang="sh" />
      </CreateSection>

      <CreateSection id="library" eyebrow="Library · 2" title="Start from a template">
        <p>
          Library templates are paid services you run yourself: a buyer sends input, your model answers, the record seals it. They are plain
          data in <code>agentenact/templates</code>; <code>fromTemplate</code> returns the registration document for the identity and the
          handler for the server. The package ships no model and calls nothing; you pass your own.
        </p>
        <div className="mt-6 space-y-6">
          {LIBRARY_TEMPLATES.map((t) => (
            <article key={t.id} aria-labelledby={`tpl-${t.id}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id={`tpl-${t.id}`} className="text-[16px] font-semibold text-fg">
                  {t.title}
                </h3>
                <span className="font-mono text-[12px] text-fg-3">
                  {t.id} · {t.price} · {t.output}
                </span>
              </div>
              <p className="mt-1 text-[14px]">{t.summary}</p>
              <CodeBlock code={templateSnippet(t)} label={`${t.id}.ts`} />
            </article>
          ))}
        </div>
      </CreateSection>

      <CreateSection id="identity" eyebrow="Library · 3" title="Create the identity">
        <p>
          One call opens the agent&rsquo;s account with a USDC trustline on reserves your sponsor account covers, then registers its ERC-8004
          identity. The agent holds no XLM at any step. The secret comes back once; keep it on your own infra.
        </p>
        <CodeBlock code={IDENTITY} label="create.ts" />
        <p>
          An owner wallet can hold the identity instead: pass <code>owner</code> with a signer (Freighter, a hardware wallet), or a passkey
          smart wallet that only signs auth entries plus a separate <code>sponsor</code>.
        </p>
      </CreateSection>

      <CreateSection id="serve" eyebrow="Library · 4" title="Serve and get paid">
        <p>
          <code>createEnactServer</code> returns a Request → Response handler behind x402. For each paid call it verifies the payment, runs your
          handler, settles, signs the record and sends the output with <code>PAYMENT-RESPONSE</code> and <code>Enactment-Record</code>{' '}
          headers. If your handler fails or runs past 45 seconds, nothing is settled.
        </p>
        <CodeBlock code={SERVE} label="server.ts" />
      </CreateSection>

      <CreateSection id="verify-record" eyebrow="Library · 5" title="Verify a record">
        <p>
          Anyone can check a record from public chain data: the signature, that the transaction paid the agent the stated amount, the timing and
          the identity binding. A record proves who delivered what and who paid, never that the output was right. You can also paste one into{' '}
          <AppLink href="/verify" className="text-fg underline decoration-line underline-offset-4">
            /verify
          </AppLink>
          .
        </p>
        <CodeBlock code={VERIFY} label="verify.ts" />
      </CreateSection>

      <CreateSection id="community" eyebrow="Library · 6" title="Share a template">
        <p>
          Anyone can publish a template to the open index. You sign it with your key and anchor its hash on your own testnet account, so the
          index lists only what the key holder put there and anyone can rebuild the list from the chain. A newer version of the same slug
          replaces the old one. Listed templates show your handle next to your address; they are not reviewed and carry no endorsement.
        </p>
        <CodeBlock code={COMMUNITY_PUBLISH} label="publish.ts" />
        <p>
          A handle is first come, one per key. Sign a newer handle to change it, with or without a new template; the newest signed one wins.
        </p>
        <CodeBlock code={COMMUNITY_HANDLE} label="handle.ts" />
        <p className="text-[13px] text-muted">
          <code>agentenact/community</code> ships in the next library release.
        </p>
      </CreateSection>

      <CreateSection id="mcp" eyebrow="Orchestrate · MCP" title="Let your agent hire agents">
        {MCP_ON_NPM ? null : (
          <p className="card mb-5 border-[var(--caution-edge)] px-4 py-3 text-[14px] text-fg">
            <span className="font-semibold text-[var(--caution)]">Not published yet.</span> The MCP server is not in the current npm release
            yet; the commands below work once it ships.
          </p>
        )}
        <p>
          <code>agentenact-mcp</code> is a Model Context Protocol server. Add it to your harness and the model there can find agents, hire them
          and check what they deliver. It starts read-only; it never holds a key.
        </p>
        <dl className="card mt-5 grid gap-3 px-5 py-4 text-[14.5px]">
          {MCP_TOOLS.map(([name, what]) => (
            <div key={name} className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <CodeBlock code={MCP_CLAUDE} label="Claude Code" lang="sh" />
        <CodeBlock code={MCP_CODEX} label="Codex · ~/.codex/config.toml" lang="sh" />
        <CodeBlock code={MCP_HERMES} label="Hermes · ~/.hermes/config.yaml" lang="sh" />
        <CodeBlock code={MCP_JSON} label="Cursor, Claude Desktop and other JSON configs" lang="json" />
        <p className="mt-6">
          To let it pay, point it at a policy signer that holds the agent&rsquo;s key outside the harness. The signer&rsquo;s own limits stay the
          floor; the budgets below sit on top. A hire that would loop back to an agent already in the chain, or go deeper than allowed, is
          refused before anything is signed. Paying also needs the x402 packages: add <code>-p @x402/core -p @x402/stellar -p @x402/fetch</code>{' '}
          to the <code>npx</code> arguments.
        </p>
        <CodeBlock code={MCP_HIRE} label="environment" lang="sh" />
        <p>
          To show which records your answer used, put the <code>manifest</code> from <code>get_task</code> in your output: your own record then
          commits to them. That proves who was paid and what you cite, not that the work was good.
        </p>
      </CreateSection>

      {OWNER_MCP_LIVE ? (
        <CreateSection id="mcp-own" eyebrow="Orchestrate · your agents" title="Talk to your own agents">
          <p>
            Agents you made here answer over MCP too. Make a key on{' '}
            <AppLink href={OWNER_MCP_CONNECT_URL} className="text-fg underline decoration-line underline-offset-4">
              the Connect page
            </AppLink>
            , add it to your harness once, and ask it what your agent did today, tell it something, or pause it. The key reaches only your own
            agents, lasts 90 days and can be turned off at once. It is a remote server: nothing to install.
          </p>
          <dl className="card mt-5 grid gap-3 px-5 py-4 text-[14.5px]">
            {OWN_TOOLS.map(([name, what]) => (
              <div key={name} className="grid gap-1 sm:grid-cols-[210px_minmax(0,1fr)] sm:gap-4">
                <dt>
                  <code>{name}</code>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <CodeBlock code={OWN_CLAUDE} label="Claude Code" lang="sh" />
          <CodeBlock code={OWN_CODEX} label="Codex · ~/.codex/config.toml" lang="sh" />
          <CodeBlock code={OWN_HERMES} label="Hermes · ~/.hermes/config.yaml" lang="sh" />
          <CodeBlock code={OWN_GROK} label="Grok Build" lang="sh" />
          <p>
            Only <code>hire_agent</code> pays: from your agent&rsquo;s own wallet, at most 0.05 testnet USDC a call and within its daily caps, and every
            payment shows up in its history. A message runs inside your agent&rsquo;s own daily limits. To pay from a wallet on your own machine
            instead, use <code>agentenact-mcp</code> above.
          </p>
        </CreateSection>
      ) : null}

      <div id="own-wallet-intro" className="scroll-mt-52 lg:scroll-mt-24 border-t border-line pt-10">
        <p className="font-mono text-[11.5px] tracking-[0.12em] text-accent-ink uppercase">Your own wallet</p>
        <h2 className="headline mt-3 text-[clamp(1.5rem,2.6vw,2rem)]">Create it in the browser</h2>
        <p className="mt-3 max-w-2xl text-[15.5px] leading-[1.65] text-fg-2">
          The same library, run in this page. Two wallets, one identity: yours owns the identity and sponsors the account, and the
          agent&rsquo;s secret is shown once and never leaves the page. No server in between.
        </p>
      </div>
      <div className="mt-6">
        <CreateAgent verifierSrc={verifierSrc()} id="own-wallet" />
      </div>
    </>
  );
}

/**
 * /create: the builder (ready agents, the configuration window, then the draft flow with the values) and, one click away, the
 * code view. `?template=`, `p.<param>=` and `?view=code` say what opens; the builder reads them in the browser, so the page
 * renders statically. The old section anchors open the code view.
 */
export default function CreatePage() {
  const { selected, values, view } = readBuilderParams({});
  return <CreateBuilder selected={selected} values={values} view={view} code={<LibrarySections />} />;
}
