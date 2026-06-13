import Head from "next/head";
import { useState } from "react";
import { useRouter } from "next/router";
import { NPC_CONFIGS } from "@/game/data/npc-configs";

const npcs = Object.values(NPC_CONFIGS);

export default function Home() {
  const [name, setName] = useState("");
  const router = useRouter();

  const handleStart = () => {
    const visitorName = name.trim() || "Visitor";
    router.push(`/town?name=${encodeURIComponent(visitorName)}`);
  };

  return (
    <>
      <Head>
        <title>Thomas&apos;s Town</title>
        <meta name="description" content="An interactive pixel art portfolio - walk around and meet the five Thomases" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.png" />
      </Head>

      <main
        className="min-h-screen flex items-center justify-center p-4"
        style={{ background: 'var(--paper)', color: 'var(--ink)' }}
      >
        <div className="w-full max-w-sm text-center">
          <h1
            className="text-4xl mb-2"
            style={{ fontFamily: 'var(--display)', fontWeight: 600, letterSpacing: '-0.01em' }}
          >
            Thomas&apos;s Town
          </h1>
          <p className="text-sm mb-8" style={{ color: 'var(--ink-2)' }}>
            A pixel art world with five AI versions of me
          </p>

          {/* Resident icons */}
          <div className="flex justify-center gap-3 mb-8">
            {npcs.map(config => (
              <div key={config.id} className="flex flex-col items-center gap-1">
                <div
                  className="rounded-lg p-1"
                  style={{ backgroundColor: config.color + '15' }}
                >
                  <div
                    style={{
                      width: 16,
                      height: 24,
                      backgroundImage: `url(/assets/sprites/${config.sprite}.png)`,
                      backgroundPosition: '0 0',
                      backgroundSize: '64px 96px',
                      imageRendering: 'pixelated' as const,
                      transform: 'scale(2)',
                      transformOrigin: 'center',
                    }}
                  />
                </div>
                <span
                  className="text-[9px] uppercase"
                  style={{ fontFamily: 'var(--mono)', letterSpacing: '0.04em', color: config.color }}
                >
                  {config.displayName.replace('Thomas', '').trim()}
                </span>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
              placeholder="Your name"
              autoFocus
              className="w-full text-sm px-4 py-3 rounded-xl focus:outline-none transition-colors"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line-2)',
                color: 'var(--ink)',
                fontFamily: 'var(--sans)',
              }}
            />
            <button
              onClick={handleStart}
              className="w-full text-sm py-3 rounded-xl transition-opacity hover:opacity-90"
              style={{
                background: 'var(--career)',
                color: '#fff',
                fontFamily: 'var(--display)',
                fontWeight: 600,
                boxShadow: 'var(--shadow)',
              }}
            >
              Enter Town
            </button>

            {/* Observer mode: everything visible, nothing interactive — the
                agents never know you're there. */}
            <button
              onClick={() => router.push('/observe')}
              className="w-full text-sm py-2.5 rounded-xl transition-colors"
              style={{
                background: 'transparent',
                color: 'var(--ink-2)',
                fontFamily: 'var(--display)',
                fontWeight: 600,
                border: '1px solid var(--line-2)',
              }}
            >
              Just observe — watch without being seen
            </button>
          </div>

          <div
            className="mt-8 flex justify-center gap-6 text-xs uppercase"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em', color: 'var(--ink-3)' }}
          >
            <span>WASD to move</span>
            <span>SPACE to interact</span>
          </div>
        </div>
      </main>
    </>
  );
}
