import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { Fredoka, Nunito_Sans, Silkscreen } from "next/font/google";

// Design-system type (M2 design doc §6.3, from the handoff): Fredoka for
// display/nameplates, Nunito Sans for body/chat, Silkscreen for pixel accents.
// next/font/google self-hosts these at build time (no runtime dep, no network
// on the visitor's first paint) and exposes each as a CSS variable consumed by
// styles/tokens.css.
const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const nunito = Nunito_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
  variable: "--font-body",
  display: "swap",
});

const silkscreen = Silkscreen({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-pixel",
  display: "swap",
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${fredoka.variable} ${nunito.variable} ${silkscreen.variable}`}>
      <Component {...pageProps} />
    </div>
  );
}
