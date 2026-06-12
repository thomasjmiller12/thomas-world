import "@/styles/globals.css";
import { useEffect } from "react";
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
  // The --font-* variables MUST live on <html>, not a wrapper div: tokens.css
  // composes them into --sans/--display/--mono at :root, and a custom property
  // substitutes var() references at the element where it is DECLARED. With the
  // fonts scoped to a child div, --sans computed to guaranteed-invalid at :root
  // and every `font:` shorthand in the app silently fell back to 16px system-ui.
  useEffect(() => {
    const cls = [fredoka.variable, nunito.variable, silkscreen.variable];
    document.documentElement.classList.add(...cls);
    return () => document.documentElement.classList.remove(...cls);
  }, []);
  return (
    <div className={`${fredoka.variable} ${nunito.variable} ${silkscreen.variable}`}>
      <Component {...pageProps} />
    </div>
  );
}
