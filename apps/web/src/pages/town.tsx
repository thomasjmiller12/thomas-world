import Head from "next/head";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";

const GameApp = dynamic(() => import("@/App"), { ssr: false });

export default function TownPage() {
  const router = useRouter();
  const visitorName = (router.query.name as string) || "Visitor";
  // ?observe=1 → ghost mode: the world renders and streams, but no visitor is
  // registered and chat is disabled — a translucent walkabout, unseen.
  const observe = router.query.observe === "1";
  // ?about=1 → open the About / Portfolio hub on arrival (the home page's
  // "About Thomas / How this works" entry).
  const openAbout = router.query.about === "1";

  return (
    <>
      <Head>
        <title>Thomas&apos;s Town</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.png" />
      </Head>
      <GameApp visitorName={visitorName} observe={observe} openAbout={openAbout} />
    </>
  );
}
