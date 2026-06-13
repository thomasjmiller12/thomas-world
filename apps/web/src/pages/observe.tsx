import Head from 'next/head';
import dynamic from 'next/dynamic';

// Client-only: the dashboard boots a WorldClient (EventSource, localStorage).
const ObserveDashboard = dynamic(
  () => import('@/components/observe/ObserveDashboard').then((m) => m.ObserveDashboard),
  { ssr: false },
);

export default function ObservePage() {
  return (
    <>
      <Head>
        <title>Thomas&apos;s Town — Observing</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.png" />
      </Head>
      <ObserveDashboard />
    </>
  );
}
