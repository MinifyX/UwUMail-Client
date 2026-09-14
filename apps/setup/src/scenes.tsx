import { NYU, Nyu, Paw, Sticker } from "@nyu/Nyu";
import { Heart, Letter, NyuScene, Shadow, Star } from "@nyu/scenes";

// Installer scenes on the same 320 × 220 canvas as the app's scenes.

function Canvas({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <svg
      viewBox="-10 -10 340 230"
      className="nyu-host nyu-blink w-full overflow-visible"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** Nyu hops and tosses letters into a box. */
export function WorkingScene() {
  const S = { stroke: NYU.ink, strokeWidth: 6 } as const;
  return (
    <Canvas>
      <Shadow cx={150} rx={120} />
      <Sticker edge={18}>
        <path d="M206 134 L178 116 L190 102 L226 134Z" fill={NYU.kraftLight} {...S} />
        <path d="M290 134 L318 116 L306 102 L270 134Z" fill={NYU.kraftLight} {...S} />
        <path d="M200 134 H296 L288 200 H208Z" fill={NYU.kraft} {...S} />
        <Heart x={248} y={168} size={0.7} />
      </Sticker>
      {[0, 1, 2].map((index) => (
        <g key={index} className="setup-toss" style={{ animationDelay: `${index * 0.55}s` }}>
          <Sticker edge={12}>
            <Letter x={118} y={96} rotate={-12} seal={index === 1} />
          </Sticker>
        </g>
      ))}
      <g className="setup-hop">
        <Nyu mood="happy" x={96} y={126} scale={0.38} tilt={-4} front={<Paw x={430} y={250} />} />
      </g>
      <Sticker edge={12}>
        <Star x={292} y={44} r={11} />
        <Star x={30} y={48} r={8} />
      </Sticker>
    </Canvas>
  );
}

/** Nyu waves goodbye with a little tear. */
export function GoodbyeScene() {
  return (
    <Canvas>
      <Shadow />
      <Nyu mood="sad" x={160} y={124} scale={0.42} tilt={4} front={<Paw x={440} y={196} className="nyu-wave" />} />
      <Sticker edge={12}>
        <g className="setup-float">
          <Heart x={62} y={58} size={0.85} fill={NYU.lilac} />
        </g>
        <Star x={276} y={46} r={9} />
      </Sticker>
    </Canvas>
  );
}

export function WelcomeScene() {
  return <NyuScene name="welcome" className="w-full" />;
}

export function DoneScene() {
  return (
    <div className="setup-pop w-full">
      <NyuScene name="done" className="w-full" />
    </div>
  );
}

export function ErrorScene() {
  return <NyuScene name="loadError" className="w-full" />;
}

export function PuzzledScene() {
  return <NyuScene name="noPreview" className="w-full" />;
}
