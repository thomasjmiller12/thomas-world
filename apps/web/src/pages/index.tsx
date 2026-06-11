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

      <main className="min-h-screen bg-[#15132a] flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-3xl font-bold text-[#e8ddd0] mb-2 tracking-tight">
            Thomas&apos;s Town
          </h1>
          <p className="text-[#c4b5a0]/50 text-sm mb-8">
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
                <span className="text-[9px] font-mono" style={{ color: config.color + 'aa' }}>
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
              className="w-full bg-[#c4b5a0]/5 border border-[#3d3654]/40 text-[#e8ddd0] text-sm px-4 py-3 rounded-lg focus:outline-none focus:border-[#3d3654]/80 focus:ring-1 focus:ring-[#3d3654]/40 placeholder-[#c4b5a0]/25 transition-colors"
            />
            <button
              onClick={handleStart}
              className="w-full bg-[#4A90D9]/80 hover:bg-[#4A90D9] text-[#e8ddd0] text-sm font-medium py-3 rounded-lg transition-colors"
            >
              Enter Town
            </button>
          </div>

          <div className="mt-8 flex justify-center gap-6 text-[#c4b5a0]/30 text-xs">
            <span>WASD to move</span>
            <span>SPACE to interact</span>
          </div>
        </div>
      </main>
    </>
  );
}
