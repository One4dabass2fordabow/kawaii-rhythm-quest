import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import heroImg from "@/assets/hero.png";
import enemyImg from "@/assets/enemy.png";
import bossImg from "@/assets/boss.png";
import bgImg from "@/assets/background.png";
import levelMusicAsset from "@/assets/level-music.mp3.asset.json";
import bossMusicAsset from "@/assets/boss-music.mp3.asset.json";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Contrebasse Quest - Desert Symphony" },
      { name: "description", content: "Jeu de plateforme 2D musical avec une contrebasse kawaii dans le désert." },
    ],
  }),
  component: Game,
});

type Enemy = {
  x: number; y: number; vx: number; vy: number;
  baseY: number; patrolMin: number; patrolMax: number;
  state: "patrol" | "dive"; tint: "yellow" | "red" | "black";
  hp: number; alive: boolean; w: number; h: number;
};
type Platform = { x: number; y: number; w: number; h: number };
type Note = { x: number; y: number; collected: boolean; phase: number };
type Bow = { x: number; y: number; vx: number; t: number; active: boolean; returning: boolean; boomerang: boolean };
type BossProj = { x: number; y: number; vx: number; vy: number; t: number };

const W = 960, H = 540;
const GRAVITY = 0.7;
const LEVEL_W = 9600;

// Recolor an image into a new canvas: replace black-ish pixels and blue-ish (violin body) pixels with target colors.
function recolorEnemy(src: HTMLImageElement, headColor: [number,number,number], bodyColor: [number,number,number]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const cx = c.getContext("2d")!;
  cx.drawImage(src, 0, 0);
  const img = cx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
    if (a < 10) continue;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const lum = (r+g+b)/3;
    // Dark / black areas → head color (keep luminance variations)
    if (lum < 90 && max - min < 60) {
      const k = lum / 90; // 0..1 shade
      d[i]   = headColor[0] * k;
      d[i+1] = headColor[1] * k;
      d[i+2] = headColor[2] * k;
    }
    // Blue-ish violin body → body color
    else if (b > r + 20 && b > g + 10) {
      const k = Math.min(1, lum / 180);
      d[i]   = bodyColor[0] * (0.4 + 0.6*k);
      d[i+1] = bodyColor[1] * (0.4 + 0.6*k);
      d[i+2] = bodyColor[2] * (0.4 + 0.6*k);
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ui, setUi] = useState({ life: 3, stars: 0, score: 0, bossHp: 10, gameState: "play" as "play"|"win"|"lose", musicOn: false });
  const musicCtrl = useRef<{start: () => void; stop: () => void} | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const load = (src: string) => new Promise<HTMLImageElement>(res => {
      const i = new Image(); i.onload = () => res(i); i.src = src;
    });

    let raf = 0;
    let stopped = false;

    (async () => {
      const [hero, enemy, boss, bg] = await Promise.all([load(heroImg), load(enemyImg), load(bossImg), load(bgImg)]);

      // Pre-recolored enemy variants
      const enemySprites: Record<"yellow"|"red"|"black", HTMLCanvasElement> = {
        yellow: recolorEnemy(enemy, [230, 190, 40],  [255, 215, 70]),
        red:    recolorEnemy(enemy, [170, 25, 25],   [220, 50, 50]),
        black:  recolorEnemy(enemy, [20, 20, 20],    [55, 55, 60]),
      };

      const player = {
        x: 100, y: 100, vx: 0, vy: 0, w: 160, h: 220,
        onGround: false, jumps: 0, facing: 1,
        attackTimer: 0, invuln: 0, swingAnim: 0,
      };

      // ===== Audio =====
      let audioCtx: AudioContext | null = null;
      const ensureCtx = () => {
        if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
        return audioCtx;
      };
      const playBassHit = () => {
        try {
          const c2 = ensureCtx();
          const now = c2.currentTime;
          [55, 58.3].forEach((f, idx) => {
            const osc = c2.createOscillator();
            const gain = c2.createGain();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(f, now);
            osc.frequency.linearRampToValueAtTime(f * 0.85, now + 0.6);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
            const filter = c2.createBiquadFilter();
            filter.type = "lowpass"; filter.frequency.value = 600;
            osc.connect(filter); filter.connect(gain); gain.connect(c2.destination);
            osc.start(now + idx * 0.03); osc.stop(now + 0.75);
          });
        } catch {}
      };
      const playSwoosh = () => {
        try {
          const c2 = ensureCtx();
          const now = c2.currentTime;
          const osc = c2.createOscillator();
          const gain = c2.createGain();
          const filter = c2.createBiquadFilter();
          filter.type = "bandpass"; filter.frequency.value = 1200; filter.Q.value = 2;
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(800, now);
          osc.frequency.exponentialRampToValueAtTime(220, now + 0.18);
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
          osc.connect(filter); filter.connect(gain); gain.connect(c2.destination);
          osc.start(now); osc.stop(now + 0.22);
        } catch {}
      };

      // Music: real MP3 tracks, switch when boss appears
      const levelAudio = new Audio(levelMusicAsset.url);
      levelAudio.loop = true; levelAudio.volume = 0.55;
      const bossAudio = new Audio(bossMusicAsset.url);
      bossAudio.loop = true; bossAudio.volume = 0.65;
      let currentTrack: "level" | "boss" | null = null;
      let musicEnabled = false;
      const fadeTo = (a: HTMLAudioElement, target: number, ms = 600) => {
        const start = a.volume, t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now()-t0)/ms);
          a.volume = start + (target-start)*k;
          if (k < 1) requestAnimationFrame(step);
          else if (target === 0) a.pause();
        };
        step();
      };
      const playTrack = (which: "level" | "boss") => {
        if (!musicEnabled) return;
        if (currentTrack === which) return;
        const next = which === "level" ? levelAudio : bossAudio;
        const prev = which === "level" ? bossAudio : levelAudio;
        if (!prev.paused) fadeTo(prev, 0, 500);
        next.volume = 0;
        next.play().then(() => fadeTo(next, which === "boss" ? 0.65 : 0.55, 500)).catch(() => {});
        currentTrack = which;
      };
      const startMusic = () => {
        musicEnabled = true;
        playTrack("level");
      };
      const stopMusic = () => {
        musicEnabled = false;
        try { fadeTo(levelAudio, 0, 300); } catch {}
        try { fadeTo(bossAudio, 0, 300); } catch {}
        currentTrack = null;
      };
      musicCtrl.current = {
        start: () => { startMusic(); setUi(u => ({...u, musicOn: true})); },
        stop:  () => { stopMusic();  setUi(u => ({...u, musicOn: false})); },
      };


      // ===== World (bigger level) =====
      const platforms: Platform[] = [
        { x: 0, y: 480, w: LEVEL_W, h: 60 },
      ];
      // Generate platforms procedurally across the level
      let px2 = 350;
      while (px2 < LEVEL_W - 600) {
        const pw = 140 + Math.random()*120;
        const py = 240 + Math.random()*180;
        platforms.push({ x: px2, y: py, w: pw, h: 24 });
        px2 += pw + 90 + Math.random()*120;
      }

      const tints: Array<"yellow"|"red"|"black"> = ["yellow","red","black"];
      const enemies: Enemy[] = [];
      for (let i = 0; i < 22; i++) {
        const ex = 500 + i * (LEVEL_W - 1200) / 22 + Math.random()*80;
        const ey = 140 + Math.random()*120;
        enemies.push({
          x: ex, y: ey, vx: 0.6 * (Math.random()<0.5?-1:1), vy: 0,
          baseY: ey, patrolMin: ex - 140, patrolMax: ex + 140,
          state: "patrol", tint: tints[i % 3], hp: 1, alive: true, w: 70, h: 100,
        });
      }

      const notes: Note[] = [];
      const noteCount = 70;
      for (let i = 0; i < noteCount; i++) {
        notes.push({
          x: 300 + i * (LEVEL_W - 600) / noteCount + Math.random()*40,
          y: 180 + Math.random() * 240,
          collected: false, phase: Math.random()*Math.PI*2,
        });
      }

      const bossX = LEVEL_W - 400;
      const bossObj = {
        x: bossX, y: 220, vx: 0, vy: 0, w: 220, h: 320,
        hp: 10, onGround: false, jumpTimer: 60, attackTimer: 120, hitFlash: 0, alive: true,
        everHit: false,
      };

      const bows: Bow[] = [];
      const bossProjs: BossProj[] = [];

      const keys: Record<string, boolean> = {};
      let spaceHoldStart = 0;
      let spaceFired = false;
      let musicAutoStarted = false;
      const SPACE_LONG_MS = 250;

      const downKey = (e: KeyboardEvent) => {
        if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
        // Auto-start level music on first gameplay key press
        if (!musicAutoStarted && ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) {
          musicAutoStarted = true;
          startMusic();
          setUi(u => ({...u, musicOn: true}));
        }
        if (e.key === "ArrowUp" && !keys.ArrowUp) {
          if (player.onGround) { player.vy = -13; player.jumps = 1; player.onGround = false; }
          else if (player.jumps < 2) { player.vy = -11; player.jumps = 2; }
        }
        if (e.key === " " && !keys[" "]) {
          spaceHoldStart = performance.now();
          spaceFired = false;
          player.swingAnim = 18;
          playSwoosh();
        }
        keys[e.key] = true;
      };
      const upKey = (e: KeyboardEvent) => {
        if (e.key === " ") {
          const heldMs = performance.now() - spaceHoldStart;
          if (!spaceFired) {
            if (heldMs >= SPACE_LONG_MS) {
              // Long press → boomerang throw
              bows.push({
                x: player.x + player.w/2 + 40*player.facing,
                y: player.y + 80,
                vx: 11 * player.facing, t: 0, active: true, returning: false, boomerang: true,
              });
            }
            // Short press = melee only (handled by swing animation hitbox)
            spaceFired = true;
          }
        }
        keys[e.key] = false;
      };
      window.addEventListener("keydown", downKey);
      window.addEventListener("keyup", upKey);

      let camX = 0;
      let life = 3, stars = 0, score = 0;
      let gameState: "play"|"win"|"lose" = "play";
      let tick = 0;

      const collidesRect = (a: {x:number;y:number;w:number;h:number}, b: {x:number;y:number;w:number;h:number}) =>
        a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;

      const loop = () => {
        if (stopped) return;
        tick++;
        if (gameState === "play") {
          const speed = 4.5;
          if (keys.ArrowLeft) { player.vx = -speed; player.facing = -1; }
          else if (keys.ArrowRight) { player.vx = speed; player.facing = 1; }
          else player.vx *= 0.75;

          player.vy += GRAVITY;
          player.x += player.vx;
          player.y += player.vy;

          player.onGround = false;
          for (const p of platforms) {
            if (player.x + player.w > p.x && player.x < p.x + p.w) {
              if (player.vy >= 0 && player.y + player.h - player.vy <= p.y + 2 && player.y + player.h >= p.y) {
                player.y = p.y - player.h;
                player.vy = 0;
                player.onGround = true;
                player.jumps = 0;
              }
            }
          }
          if (player.x < 0) player.x = 0;
          if (player.x + player.w > LEVEL_W) player.x = LEVEL_W - player.w;
          if (player.y > H + 200) { life--; playBassHit(); player.x = 100; player.y = 100; player.vy = 0; player.invuln = 90; }

          if (player.invuln > 0) player.invuln--;
          if (player.swingAnim > 0) player.swingAnim--;

          camX = Math.max(0, Math.min(LEVEL_W - W, player.x - W/2 + player.w/2));

          // Melee swing hitbox during animation
          const meleeActive = player.swingAnim > 4 && player.swingAnim < 16;
          const meleeBox = meleeActive ? {
            x: player.facing === 1 ? player.x + player.w - 20 : player.x - 110,
            y: player.y + 30,
            w: 140, h: 140,
          } : null;

          // Enemies AI (slower)
          for (const e of enemies) {
            if (!e.alive) continue;
            const dx = (player.x + player.w/2) - (e.x + e.w/2);
            const dy = (player.y + player.h/2) - (e.y + e.h/2);
            const dist = Math.hypot(dx, dy);
            if (e.state === "patrol") {
              e.y = e.baseY + Math.sin(tick*0.04 + e.x)*8;
              e.x += e.vx;
              if (e.x < e.patrolMin) e.vx = Math.abs(e.vx);
              if (e.x > e.patrolMax) e.vx = -Math.abs(e.vx);
              if (dist < 220 && player.y > e.y) {
                e.state = "dive";
                e.vx = Math.sign(dx) * 1.8;
                e.vy = 2.4;
              }
            } else {
              e.x += e.vx;
              e.vy += 0.2;
              e.y += e.vy;
              if (e.y > 460) {
                e.state = "patrol";
                e.y = e.baseY; e.vy = 0; e.vx = 0.6 * (Math.random()<0.5?-1:1);
              }
            }
            const eb = { x: e.x+10, y: e.y+10, w: e.w-20, h: e.h-20 };
            // Melee kill
            if (meleeBox && collidesRect(meleeBox, eb)) {
              e.alive = false; score += 200;
              continue;
            }
            const pb = { x: player.x+15, y: player.y+10, w: player.w-30, h: player.h-20 };
            if (collidesRect(pb, eb) && player.invuln === 0) {
              if (player.vy > 2 && player.y + player.h < e.y + e.h/2 + 20) {
                e.alive = false; player.vy = -10; score += 200;
              } else {
                life--; playBassHit(); player.invuln = 90;
                player.vy = -8; player.vx = -player.facing * 6;
              }
            }
          }

          // Melee on boss
          if (meleeBox && bossObj.alive && score >= 20000) {
            const bb = { x: bossObj.x+30, y: bossObj.y+20, w: bossObj.w-60, h: bossObj.h-40 };
            if (collidesRect(meleeBox, bb) && bossObj.hitFlash === 0) {
              bossObj.hp--; bossObj.hitFlash = 20; score += 100; bossObj.everHit = true;
              if (bossObj.hp <= 0) { bossObj.alive = false; gameState = "win"; }
            }
          }

          // Boomerangs
          for (const b of bows) {
            b.t++;
            b.x += b.vx;
            if (b.boomerang) {
              if (!b.returning && b.t > 35) b.returning = true;
              if (b.returning) {
                const ddx = (player.x + player.w/2) - b.x;
                b.vx = Math.sign(ddx) * 11;
                if (Math.abs(ddx) < 25) b.active = false;
              }
            } else {
              if (b.t > 30) b.active = false;
            }
            const hb = {x:b.x-32, y:b.y-12, w:64, h:24};
            for (const e of enemies) {
              if (!e.alive) continue;
              if (collidesRect(hb, {x:e.x+10,y:e.y+10,w:e.w-20,h:e.h-20})) {
                e.alive = false; score += 150;
              }
            }
            if (bossObj.alive && score >= 20000 && collidesRect(hb, {x:bossObj.x+30,y:bossObj.y+20,w:bossObj.w-60,h:bossObj.h-40})) {
              if (bossObj.hitFlash === 0) {
                bossObj.hp--; bossObj.hitFlash = 20; score += 100; bossObj.everHit = true;
                if (bossObj.hp <= 0) { bossObj.alive = false; gameState = "win"; }
              }
              b.returning = true;
            }
          }
          for (let i = bows.length-1; i>=0; i--) if (!bows[i].active) bows.splice(i,1);

          // Notes
          for (const n of notes) {
            if (n.collected) continue;
            n.phase += 0.1;
            if (collidesRect({x:player.x,y:player.y,w:player.w,h:player.h}, {x:n.x-15,y:n.y-15,w:30,h:30})) {
              n.collected = true; stars++; score += 500;
              if (life < 5 && stars % 5 === 0) life++;
            }
          }

          // Boss
          if (bossObj.alive && score >= 20000 && player.x > bossX - 600) {
            bossObj.vy += GRAVITY;
            bossObj.y += bossObj.vy;
            if (bossObj.y + bossObj.h >= 480) { bossObj.y = 480 - bossObj.h; bossObj.vy = 0; bossObj.onGround = true; }
            else bossObj.onGround = false;

            bossObj.jumpTimer--;
            if (bossObj.jumpTimer <= 0 && bossObj.onGround) {
              bossObj.vy = -15; bossObj.jumpTimer = 140 + Math.random()*60;
            }
            bossObj.attackTimer--;
            if (bossObj.attackTimer <= 0) {
              const dxb = (player.x+player.w/2) - (bossObj.x+bossObj.w/2);
              const dyb = (player.y+player.h/2) - (bossObj.y+80);
              for (let i=-1;i<=1;i++) {
                const ang = Math.atan2(dyb,dxb) + i*0.15;
                bossProjs.push({ x: bossObj.x+30, y: bossObj.y+80, vx: Math.cos(ang)*5, vy: Math.sin(ang)*5, t: 0 });
              }
              bossObj.attackTimer = 100;
            }
            if (bossObj.hitFlash > 0) bossObj.hitFlash--;

            const bb = { x: bossObj.x+30, y: bossObj.y+20, w: bossObj.w-60, h: bossObj.h-40 };
            const pb2 = { x: player.x+15, y: player.y+10, w: player.w-30, h: player.h-20 };
            if (collidesRect(pb2, bb) && player.invuln === 0) {
              if (player.vy > 2 && player.y + player.h < bossObj.y + 80) {
                if (bossObj.hitFlash === 0) {
                  bossObj.hp--; bossObj.hitFlash = 20; score += 200; bossObj.everHit = true;
                  if (bossObj.hp <= 0) { bossObj.alive = false; gameState = "win"; }
                }
                player.vy = -12;
              } else {
                life--; playBassHit(); player.invuln = 90; player.vy = -8; player.vx = -player.facing * 8;
              }
            }
          }

          for (let i = bossProjs.length-1; i>=0; i--) {
            const p = bossProjs[i];
            p.x += p.vx; p.y += p.vy; p.t++;
            const pbox = {x:p.x-10,y:p.y-10,w:20,h:20};
            // Melee swing destroys projectiles
            if (meleeBox && collidesRect(meleeBox, pbox)) {
              bossProjs.splice(i,1); score += 25; continue;
            }
            // Boomerang destroys projectiles
            let destroyed = false;
            for (const b of bows) {
              if (collidesRect({x:b.x-32,y:b.y-12,w:64,h:24}, pbox)) {
                bossProjs.splice(i,1); score += 25; destroyed = true; break;
              }
            }
            if (destroyed) continue;
            if (p.t > 240 || p.x < 0 || p.x > LEVEL_W || p.y > H+50) bossProjs.splice(i,1);
            else if (player.invuln === 0 && collidesRect(pbox, {x:player.x+15,y:player.y+10,w:player.w-30,h:player.h-20})) {
              life--; playBassHit(); player.invuln = 90; bossProjs.splice(i,1);
            }
          }

          if (life <= 0) gameState = "lose";

          // Music switch: boss music only after the player has actually struck the boss
          if (musicEnabled) {
            if (bossObj.alive && bossObj.everHit) playTrack("boss");
            else playTrack("level");
          }
        }


        // ===== RENDER =====
        ctx.clearRect(0,0,W,H);
        const sky = ctx.createLinearGradient(0,0,0,H);
        sky.addColorStop(0,"#7ec8ff"); sky.addColorStop(1,"#ffe4a8");
        ctx.fillStyle = sky; ctx.fillRect(0,0,W,H);

        const bgScale = H / bg.height;
        const bgW = bg.width * bgScale;
        const parX = -(camX * 0.4) % bgW;
        for (let x = parX - bgW; x < W; x += bgW) {
          ctx.drawImage(bg, x, 0, bgW, H);
        }
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        for (let i=0;i<8;i++){
          const cx2 = ((i*340) - camX*0.2) % (W+400);
          const x = cx2 < -200 ? cx2 + W+400 : cx2;
          ctx.beginPath(); ctx.ellipse(x, 60+i*8, 50, 16, 0, 0, Math.PI*2); ctx.fill();
        }

        for (const p of platforms) {
          const x = p.x - camX;
          if (x + p.w < 0 || x > W) continue;
          ctx.fillStyle = "#c89968"; ctx.fillRect(x, p.y, p.w, p.h);
          ctx.fillStyle = "#a67a4d"; ctx.fillRect(x, p.y, p.w, 6);
          ctx.strokeStyle = "rgba(80,50,20,0.4)"; ctx.lineWidth = 1;
          for (let bx = 0; bx < p.w; bx += 40) {
            ctx.strokeRect(x+bx, p.y, 40, Math.min(p.h, 30));
          }
        }

        for (const n of notes) {
          if (n.collected) continue;
          const x = n.x - camX;
          if (x < -30 || x > W+30) continue;
          const y = n.y + Math.sin(n.phase)*6;
          ctx.save();
          ctx.shadowColor = "#ffd84d"; ctx.shadowBlur = 12;
          ctx.fillStyle = ["#ff5d8f","#ffd84d","#5dd1ff","#a8ff5d"][Math.floor(n.x/137)%4];
          ctx.beginPath(); ctx.ellipse(x, y+6, 10, 7, -0.4, 0, Math.PI*2); ctx.fill();
          ctx.fillRect(x+7, y-14, 3, 22);
          ctx.restore();
        }

        if (bossObj.alive && score >= 20000) {
          const bx = bossObj.x - camX;
          if (bx + bossObj.w > -50 && bx < W+50) {
            ctx.save();
            if (bossObj.hitFlash > 0 && Math.floor(bossObj.hitFlash/3)%2===0) ctx.globalAlpha = 0.4;
            ctx.drawImage(boss, bx, bossObj.y, bossObj.w, bossObj.h);
            ctx.restore();
          }
        }

        for (const p of bossProjs) {
          const x = p.x - camX;
          ctx.save();
          ctx.shadowColor = "#ffb347"; ctx.shadowBlur = 15;
          ctx.fillStyle = "#ffcd3a";
          ctx.beginPath(); ctx.arc(x, p.y, 7, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = "#7a3a00"; ctx.font = "bold 14px serif";
          ctx.fillText("♪", x-4, p.y+5);
          ctx.restore();
        }

        // Enemies: recolored sprite + tilt
        for (const e of enemies) {
          if (!e.alive) continue;
          const x = e.x - camX;
          if (x + e.w < -100 || x > W + 100) continue;
          const angle = e.vx >= 0 ? Math.PI/2 : -Math.PI/2;
          const sprite = enemySprites[e.tint];
          ctx.save();
          ctx.translate(x + e.w/2, e.y + e.h/2);
          ctx.rotate(angle);
          ctx.drawImage(sprite, -e.w/2, -e.h/2, e.w, e.h);
          ctx.restore();
        }

        // Player
        ctx.save();
        if (player.invuln > 0 && Math.floor(player.invuln/4)%2===0) ctx.globalAlpha = 0.4;
        const pxs = player.x - camX;
        if (player.facing === -1) {
          ctx.translate(pxs + player.w, player.y);
          ctx.scale(-1, 1);
          ctx.drawImage(hero, 0, 0, player.w, player.h);
        } else {
          ctx.drawImage(hero, pxs, player.y, player.w, player.h);
        }
        ctx.restore();

        // Swing animation — the hero's right hand swings the bow he's holding
        if (player.swingAnim > 0) {
          // Shoulder pivot (right shoulder on the sprite)
          const shoulderX = player.x + player.w * 0.55 - camX;
          const shoulderY = player.y + player.h * 0.42;
          const t = 1 - player.swingAnim / 18; // 0..1
          // Arm swings from raised-up to down-forward
          const armAngle = (-1.2 + t * 2.2) * player.facing;

          ctx.save();
          ctx.translate(shoulderX, shoulderY);
          ctx.rotate(armAngle);

          // Whoosh arc behind the bow
          ctx.strokeStyle = "rgba(255,240,180,0.45)";
          ctx.lineWidth = 9; ctx.lineCap = "round";
          ctx.beginPath(); ctx.arc(0, 0, 80, -0.6, 0.6); ctx.stroke();

          // Forearm
          ctx.strokeStyle = "#e8b98a"; ctx.lineWidth = 12; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(55, 5); ctx.stroke();
          // Sleeve cuff
          ctx.fillStyle = "#3a2615";
          ctx.beginPath(); ctx.arc(55, 5, 9, 0, Math.PI*2); ctx.fill();

          // Bow held in hand, pivoting around hand
          ctx.save();
          ctx.translate(60, 6);
          // Slight extra wrist rotation through the swing
          ctx.rotate(-0.4 + t * 0.8);
          // Wooden stick (curved bow)
          ctx.strokeStyle = "#3a1e0a"; ctx.lineWidth = 5; ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-10, 0);
          ctx.quadraticCurveTo(35, -8, 78, 0);
          ctx.stroke();
          // Horse hair string
          ctx.strokeStyle = "#fff8e0"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(-8, 2); ctx.lineTo(76, 2); ctx.stroke();
          // Frog (near hand)
          ctx.fillStyle = "#1a0d04";
          ctx.fillRect(-14, -4, 9, 9);
          // Tip
          ctx.fillStyle = "#1a0d04";
          ctx.beginPath(); ctx.arc(78, 0, 3.5, 0, Math.PI*2); ctx.fill();
          ctx.restore();

          ctx.restore();
        }

        // Thrown boomerang — small spinning bow (the one from the hero's hand)
        for (const b of bows) {
          const x = b.x - camX;
          ctx.save();
          ctx.translate(x, b.y);
          ctx.rotate(b.t * 0.5);
          ctx.shadowColor = "#ffd84d"; ctx.shadowBlur = 12;
          // Wood
          ctx.strokeStyle = "#3a1e0a"; ctx.lineWidth = 4; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(-28, 0); ctx.lineTo(28, 0); ctx.stroke();
          // Hair
          ctx.strokeStyle = "#fff8e0"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(-26, 2); ctx.lineTo(26, 2); ctx.stroke();
          // Tip/frog
          ctx.fillStyle = "#1a0d04";
          ctx.beginPath(); ctx.arc(28, 0, 3.5, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = "#5a2d10"; ctx.fillRect(-32, -4, 8, 8);
          ctx.restore();
        }


        if (bossObj.alive && score >= 20000) {
          ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(W/2-150, 50, 300, 20);
          ctx.fillStyle = "#e63946"; ctx.fillRect(W/2-148, 52, 296*(bossObj.hp/10), 16);
          ctx.fillStyle = "#fff"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
          ctx.fillText("BOSS MÉTRONOME", W/2, 45); ctx.textAlign = "left";

          // Boss approach warning — pulsing banner + arrow pointing right, until boss is on-screen and engaged
          const bossOnScreen = bossObj.x - camX < W - 60;
          if (!bossObj.everHit && !bossOnScreen) {
            const pulse = 0.55 + 0.45*Math.sin(tick*0.18);
            ctx.save();
            ctx.globalAlpha = pulse;
            ctx.fillStyle = "#e63946";
            ctx.fillRect(W/2-180, 80, 360, 38);
            ctx.strokeStyle = "#fff8e0"; ctx.lineWidth = 3;
            ctx.strokeRect(W/2-180, 80, 360, 38);
            ctx.fillStyle = "#fff8e0"; ctx.font = "bold 20px serif"; ctx.textAlign = "center";
            ctx.fillText("⚠ LE BOSS ARRIVE ! ⚠", W/2, 106);
            ctx.textAlign = "left";
            ctx.restore();

            // Arrow on the right edge pointing toward the boss
            ctx.save();
            ctx.globalAlpha = pulse;
            ctx.fillStyle = "#e63946";
            ctx.beginPath();
            ctx.moveTo(W-20, H/2);
            ctx.lineTo(W-60, H/2-30);
            ctx.lineTo(W-60, H/2-10);
            ctx.lineTo(W-90, H/2-10);
            ctx.lineTo(W-90, H/2+10);
            ctx.lineTo(W-60, H/2+10);
            ctx.lineTo(W-60, H/2+30);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "#fff8e0"; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
          }
        } else if (score < 20000) {
          ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "right";
          ctx.fillText(`Boss à 20 000 pts (${20000-score} restants)`, W-12, H-12);
          ctx.textAlign = "left";
        }

        if (gameState !== "play") {
          ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0,0,W,H);
          ctx.fillStyle = "#ffd84d"; ctx.font = "bold 64px serif"; ctx.textAlign = "center";
          ctx.fillText(gameState === "win" ? "VICTOIRE !" : "GAME OVER", W/2, H/2);
          ctx.fillStyle = "#fff"; ctx.font = "20px sans-serif";
          ctx.fillText("Recharge la page pour rejouer", W/2, H/2+40);
          ctx.textAlign = "left";
        }

        setUi(u => ({ ...u, life, stars, score, bossHp: bossObj.hp, gameState }));
        raf = requestAnimationFrame(loop);
      };
      loop();
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (musicCtrl.current) musicCtrl.current.stop();
    };
  }, []);

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center gap-4 p-4" style={{background:"linear-gradient(180deg,#2a1810,#5a3a1a)"}}>
      <h1 className="text-3xl font-bold text-amber-200 drop-shadow" style={{fontFamily:"serif"}}>
        Contrebasse Quest — Desert Symphony
      </h1>
      <div className="relative" style={{width: W, maxWidth: "100%"}}>
        <canvas ref={canvasRef} width={W} height={H} className="rounded-lg shadow-2xl border-4 border-amber-700 w-full" style={{imageRendering:"auto"}} />
        <div className="absolute top-2 left-3 right-3 flex justify-between text-amber-100 font-bold text-lg drop-shadow-md pointer-events-none" style={{fontFamily:"serif"}}>
          <div>♥ VIE : {ui.life}</div>
          <div>♪ NOTES : {ui.stars}</div>
          <div>SCORE : {ui.score.toString().padStart(6,"0")}</div>
        </div>
      </div>
      <div className="text-amber-100/80 text-sm text-center max-w-2xl">
        ← → se déplacer · ↑ sauter (↑↑ double saut) · ESPACE coup d'archet · ESPACE maintenu → lance l'archet en boomerang · sauter sur les ennemis pour les écraser
      </div>
      <button
        onClick={() => ui.musicOn ? musicCtrl.current?.stop() : musicCtrl.current?.start()}
        className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-amber-50 font-semibold shadow"
      >
        {ui.musicOn ? "♪ Couper la musique" : "♪ Lancer la musique du désert"}
      </button>
    </div>
  );
}
