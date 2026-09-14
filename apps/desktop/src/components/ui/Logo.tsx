import clsx from "clsx";
import { useId } from "react";

/** The UwUMail symbol: an envelope whose flap is a "w" mouth under two "U" eyes. */
export function LogoSymbol({ className, title }: { className?: string; title?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="80 130 352 256" className={className} role={title ? "img" : undefined} aria-hidden={!title}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF7EB0" />
          <stop offset="1" stopColor="#FF3D84" />
        </linearGradient>
      </defs>
      <rect x="88" y="138" width="336" height="240" rx="44" fill={`url(#${gradient})`} />
      <g fill="none" stroke="#fff" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round">
        <path d="M126 176 L204 276 L256 238 L308 276 L386 176" />
        <path d="M190 190 v6 a18 18 0 0 0 36 0 v-6" />
        <path d="M286 190 v6 a18 18 0 0 0 36 0 v-6" />
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2 font-extrabold tracking-[-0.02em]", className)}>
      <LogoSymbol className="h-[1.05em] w-auto" />
      <span>
        UwU<span className="text-pink">Mail</span>
      </span>
    </span>
  );
}
