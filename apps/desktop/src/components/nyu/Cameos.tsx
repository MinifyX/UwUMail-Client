import clsx from "clsx";
import { useEffect, type CSSProperties, type ReactNode } from "react";
import { finishNyu, type Cameo, type CameoName, type Hat } from "./cameo";
import { NyuHat } from "./hats";
import { Nyu, NYU, Paw, Sticker } from "./Nyu";
import { Heart, Letter, Shadow, Star } from "./scenes";
import "./cameos.css";

// Loaded lazily by <NyuStage/> the first time Nyu has something to show. Every cameo is drawn on
// the scenes' 320 × 220 canvas, with Nyu at 0.4 scale. Without animation (reduced) each one
// shows its key pose, so the resting state of every part is the picture that tells the story;
// the animations start from there and come back to it.

const S = { stroke: NYU.ink, strokeWidth: 6 } as const;
const EDGE = 18;

/** A paw in the scene's coordinates, at Nyu's 0.4 scale. */
function ScenePaw({ x, y, className }: { x: number; y: number; className?: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(0.4)`}>
      <Paw x={0} y={0} className={className} />
    </g>
  );
}

function Peek({ hat }: { hat?: Hat }) {
  return (
    <g className="nyu-c-rise">
      <Shadow cx={160} rx={70} />
      <g className="nyu-c-read">
        <Nyu mood="happy" x={160} y={124} scale={0.4} front={hat ? <NyuHat hat={hat} /> : undefined} />
      </g>
      <Sticker edge={EDGE}>
        <g transform="translate(160 176) scale(1.35)">
          <Letter x={0} y={0} seal />
        </g>
      </Sticker>
      <Sticker edge={EDGE}>
        <ScenePaw x={124} y={180} />
        <ScenePaw x={196} y={180} />
      </Sticker>
    </g>
  );
}

function Sent() {
  return (
    <>
      <Shadow cx={112} rx={74} />
      <path
        className="nyu-c-trail"
        d="M176 118 Q226 96 248 58 T300 12"
        fill="none"
        stroke={NYU.ink}
        strokeWidth={4}
        strokeDasharray="4 12"
        opacity="0.35"
      />
      <Nyu mood="happy" x={110} y={126} scale={0.4} tilt={-6} front={<Paw x={440} y={196} className="nyu-wave" />} />
      <g className="nyu-c-fly">
        <Sticker edge={EDGE}>
          <Letter x={196} y={108} rotate={-12} seal />
        </Sticker>
      </g>
      <g className="nyu-c-twinkle">
        <Sticker edge={12}>
          <Star x={286} y={96} r={10} />
          <Star x={232} y={30} r={7} />
        </Sticker>
      </g>
    </>
  );
}

function Archived() {
  return (
    <>
      <Shadow cx={170} rx={112} />
      <g className="nyu-c-drop-in">
        <Sticker edge={EDGE}>
          <Letter x={200} y={112} rotate={8} seal />
        </Sticker>
      </g>
      <g className="nyu-c-hop">
        <Nyu mood="uwu" x={76} y={130} scale={0.38} tilt={-4} />
      </g>
      <Sticker edge={EDGE}>
        <path d="M142 128 H258 L248 200 H152Z" fill={NYU.kraft} {...S} />
        <g className="nyu-c-flap-l">
          <path d="M142 128 L120 100 L150 92 L200 128Z" fill={NYU.kraftLight} {...S} />
        </g>
        <g className="nyu-c-flap-r">
          <path d="M258 128 L280 100 L250 92 L200 128Z" fill={NYU.kraftLight} {...S} />
        </g>
      </Sticker>
      <g className="nyu-c-stamp">
        <Heart x={200} y={164} size={0.8} />
      </g>
    </>
  );
}

function Bin({ lidClass }: { lidClass: string }) {
  return (
    <Sticker edge={EDGE}>
      <path d="M198 108 H278 L268 200 H208Z" fill={NYU.lilac} {...S} />
      <path d="M226 128 L229 182 M238 128 V182 M250 128 L247 182" stroke={NYU.ink} strokeWidth={5} opacity="0.3" />
      <g className={lidClass}>
        <rect x="188" y="92" width="100" height="18" rx="7" fill={NYU.violet} {...S} />
        <path d="M226 92 V82 Q226 76 232 76 H244 Q250 76 250 82 V92" fill="none" {...S} />
      </g>
    </Sticker>
  );
}

function Trashed() {
  return (
    <>
      <Shadow cx={170} rx={112} />
      <g className="nyu-c-drop-in" style={{ "--drop": "86px" } as CSSProperties}>
        <Sticker edge={EDGE}>
          <Letter x={238} y={60} rotate={14} />
        </Sticker>
      </g>
      <Bin lidClass="nyu-c-lid-open" />
      <Nyu mood="uwu" x={104} y={128} scale={0.4} tilt={-6} front={<Paw x={440} y={196} className="nyu-wave" />} />
    </>
  );
}

function Deleted() {
  return (
    <>
      <Shadow cx={170} rx={112} />
      <Nyu mood="sad" x={100} y={128} scale={0.4} tilt={-6} />
      <Bin lidClass="nyu-c-lid-slam" />
      <g className="nyu-c-puff" fill={NYU.cloud} stroke={NYU.ink} strokeWidth={4}>
        <circle cx="194" cy="74" r="13" />
        <circle cx="238" cy="58" r="16" />
        <circle cx="282" cy="74" r="12" />
      </g>
      <g className="nyu-c-twinkle">
        <Sticker edge={12}>
          <Star x={300} y={40} r={9} />
        </Sticker>
      </g>
    </>
  );
}

const CONFETTI: [x: number, y: number, rotate: number, fill: string][] = [
  [52, 50, -20, NYU.body],
  [92, 20, 30, NYU.star],
  [128, 36, 70, NYU.mint],
  [200, 24, -40, NYU.lilac],
  [240, 42, 15, NYU.body],
  [276, 18, 60, NYU.sky],
  [36, 110, 45, NYU.sky],
  [290, 104, -30, NYU.star],
];

function Birthday() {
  return (
    <>
      <Shadow />
      <g className="nyu-c-confetti">
        {CONFETTI.map(([x, y, rotate, fill]) => (
          <g key={`${x}-${y}`} style={{ "--dx": `${160 - x}px`, "--dy": `${120 - y}px` } as CSSProperties}>
            <rect
              x={x - 7}
              y={y - 4}
              width="14"
              height="8"
              rx="2"
              transform={`rotate(${rotate} ${x} ${y})`}
              fill={fill}
              stroke={NYU.ink}
              strokeWidth={3}
            />
          </g>
        ))}
      </g>
      <g className="nyu-c-hop">
        <Nyu
          mood="cheer"
          x={160}
          y={134}
          scale={0.4}
          front={
            <>
              <NyuHat hat="party" />
              <Paw x={82} y={184} />
              <Paw x={430} y={184} />
            </>
          }
        />
      </g>
    </>
  );
}

const HEARTS: [x: number, y: number, size: number, fill: string, delay: number][] = [
  [232, 62, 0.9, NYU.body, 0],
  [90, 70, 0.7, NYU.body, 180],
  [264, 104, 0.65, NYU.lilac, 360],
];

function Friend() {
  return (
    <>
      <Shadow />
      <g className="nyu-c-squish">
        <Nyu mood="happy" x={160} y={128} scale={0.4} tilt={4} />
      </g>
      {HEARTS.map(([x, y, size, fill, delay]) => (
        <g key={x} className="nyu-c-heart" style={{ animationDelay: `${delay}ms` }}>
          <Sticker edge={12}>
            <Heart x={x} y={y} size={size} fill={fill} />
          </Sticker>
        </g>
      ))}
    </>
  );
}

function Photos() {
  return (
    <>
      <Shadow />
      <Nyu mood="sparkle" x={150} y={124} scale={0.4} tilt={-4} />
      <g className="nyu-c-polaroid">
        <Sticker edge={EDGE}>
          <g transform="rotate(-8 226 126)">
            <rect x="200" y="96" width="52" height="58" rx="4" fill={NYU.paper} {...S} strokeWidth={5} />
            <rect x="208" y="104" width="36" height="32" rx="2" fill={NYU.sky} />
            <path d="M208 136 L222 120 L232 130 L238 124 L244 136Z" fill={NYU.mint} />
            <circle cx="236" cy="112" r="4" fill={NYU.star} />
          </g>
        </Sticker>
      </g>
      <Sticker edge={EDGE}>
        <rect x="108" y="150" width="84" height="54" rx="12" fill={NYU.lilac} {...S} />
        <rect x="124" y="140" width="24" height="14" rx="4" fill={NYU.violet} {...S} strokeWidth={5} />
        <circle cx="150" cy="177" r="18" fill={NYU.sky} {...S} />
        <circle cx="150" cy="177" r="8" fill={NYU.ink} />
        <circle cx="178" cy="162" r="5" fill={NYU.star} stroke={NYU.ink} strokeWidth={3} />
      </Sticker>
      <Sticker edge={EDGE}>
        <ScenePaw x={104} y={178} />
        <ScenePaw x={196} y={178} />
      </Sticker>
      <g className="nyu-c-flash">
        <Star x={180} y={150} r={26} />
      </g>
    </>
  );
}

function Night() {
  return (
    <>
      <Shadow />
      <Sticker edge={12}>
        <path d="M268 18 A34 34 0 1 0 300 66 A26 26 0 1 1 268 18Z" fill={NYU.star} stroke={NYU.ink} strokeWidth={5} />
        <Star x={40} y={40} r={8} />
        <Star x={222} y={30} r={6} />
      </Sticker>
      <g className="nyu-c-sway">
        <Nyu mood="sleepy" x={150} y={132} scale={0.4} tilt={-6} front={<NyuHat hat="nightcap" />} />
      </g>
      <g className="nyu-c-zzz">
        <Sticker edge={12}>
          <g fill="none" stroke={NYU.ink}>
            <path d="M224 92 h12 l-12 12 h12" strokeWidth={4} />
            <path d="M246 60 h16 l-16 16 h16" strokeWidth={5} />
          </g>
        </Sticker>
      </g>
    </>
  );
}

const SCENES: Record<CameoName, (props: { hat?: Hat }) => ReactNode> = {
  peek: Peek,
  sent: Sent,
  archived: Archived,
  trashed: Trashed,
  deleted: Deleted,
  birthday: Birthday,
  friend: Friend,
  photos: Photos,
  night: Night,
};

/** One cameo in its corner. Goes away by itself after its time; decorative only. */
export default function CameoView({ cameo }: { cameo: Cameo }) {
  const { id, duration } = cameo;
  useEffect(() => {
    const timer = window.setTimeout(() => finishNyu(id), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration]);
  const Scene = SCENES[cameo.name];
  return (
    <div
      key={id}
      className={clsx("nyu-stage", cameo.still && "nyu-stage-still")}
      data-cameo={cameo.name}
      style={{ "--nyu-cameo-ms": `${duration}ms` } as CSSProperties}
      aria-hidden
    >
      <svg
        viewBox="-10 -10 340 230"
        className="nyu-host overflow-visible"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        <Scene hat={cameo.hat} />
      </svg>
    </div>
  );
}
