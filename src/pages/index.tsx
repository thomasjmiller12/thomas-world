import Head from "next/head";
import { useState } from "react";
import { useRouter } from "next/router";

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

      <main className="min-h-screen bg-[#0f0f1a] flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center">
          {/* Title */}
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
            Thomas&apos;s Town
          </h1>
          <p className="text-gray-500 text-sm mb-10">
            A pixel art world with five AI versions of me
          </p>

          {/* Input */}
          <div className="space-y-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
              placeholder="Your name"
              autoFocus
              className="w-full bg-white/5 border border-white/10 text-white text-sm px-4 py-3 rounded-lg focus:outline-none focus:border-[#4A90D9]/50 focus:ring-1 focus:ring-[#4A90D9]/30 placeholder-gray-600 transition-colors"
            />
            <button
              onClick={handleStart}
              className="w-full bg-[#4A90D9] hover:bg-[#3a7bc8] text-white text-sm font-medium py-3 rounded-lg transition-colors"
            >
              Enter Town
            </button>
          </div>

          {/* Hints */}
          <div className="mt-10 flex justify-center gap-6 text-gray-600 text-xs">
            <span>WASD to move</span>
            <span>SPACE to interact</span>
          </div>
        </div>
      </main>
    </>
  );
}
