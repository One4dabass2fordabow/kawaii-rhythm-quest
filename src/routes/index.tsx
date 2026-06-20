import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import heroImg from "@/assets/hero.png";
import enemyImg from "@/assets/enemy.png";
import bossImg from "@/assets/boss.png";
import bgImg from "@/assets/background.png";

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
type Bow = { x: number; y: number; vx: number; t: number; active: boolean; returning: boolean };
type BossProj = { x: number; y: number; vx: number; vy: number; t: number };

const W = 960, H = 540;
const GRAVITY = 0.7;
const LEVEL_W = 4800;

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ui, setUi] = useState({ life: 3, stars: 0, score: 0, bossHp: 10, gameState: "play" as "play"|"win"|"lose" });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const images: Record<string, HTMLImageElement> = {};
    const load = (src: string) => new Promise<HTMLImageElement>(res => {
      const i = new Image(); i.onload = () => res(i); i.src = src;
    });

    let raf = 0;
    let stopped = false;

    (async () => {
      const [hero, enemy, boss, bg] = await Promise.all([load(heroImg), load(enemyImg), load(bossImg), load(bgImg)]);
      images.hero = hero; images.enemy = enemy; images.boss = boss; images.bg = bg;

      // World
      const player = {
        x: 100, y: 100, vx: 0, vy: 0, w: 160, h: 220,
        onGround: false, jumps: 0, facing: 1,
        attackTimer: 0, invuln: 0, swordSwing: 0,
      };

      // WebAudio - fausse contrebasse (out-of-tune double bass) on hit
      let audioCtx: AudioContext | null = null;
      const playBassHit = () => {
        try {
          if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const ctx2 = audioCtx;
          const now = ctx2.currentTime;
          // two slightly detuned low notes that wobble
          [55, 58.3].forEach((f, idx) => {
            const osc = ctx2.createOscillator();
            const gain = ctx2.createGain();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(f, now);
            osc.frequency.linearRampToValueAtTime(f * 0.85, now + 0.6);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
            const filter = ctx2.createBiquadFilter();
            filter.type = "lowpass"; filter.frequency.value = 600;
            osc.connect(filter); filter.connect(gain); gain.connect(ctx2.destination);
            osc.start(now + idx * 0.03); osc.stop(now + 0.75);
          });
        } catch {}
      };

      const platforms: Platform[] = [
        { x: 0, y: 480, w: LEVEL_W, h: 60 }, // ground
        { x: 400, y: 380, w: 180, h: 24 },
        { x: 650, y: 320, w: 160, h: 24 },
        { x: 900, y: 380, w: 200, h: 24 },
        { x: 1250, y: 340, w: 180, h: 24 },
        { x: 1500, y: 280, w: 160, h: 24 },
        { x: 1800, y: 360, w: 220, h: 24 },
        { x: 2150, y: 300, w: 180, h: 24 },
        { x: 2450, y: 380, w: 200, h: 24 },
        { x: 2750, y: 320, w: 180, h: 24 },
        { x: 3050, y: 360, w: 200, h: 24 },
        { x: 3350, y: 300, w: 180, h: 24 },
        { x: 3650, y: 380, w: 220, h: 24 },
      ];

      const tints: Array<"yellow"|"red"|"black"> = ["yellow","red","black","yellow","red","black","yellow","red"];
      const enemies: Enemy[] = [
        { x: 500, baseY: 200 }, { x: 950, baseY: 180 }, { x: 1350, baseY: 200 },
        { x: 1700, baseY: 160 }, { x: 2050, baseY: 200 }, { x: 2400, baseY: 180 },
        { x: 2800, baseY: 200 }, { x: 3200, baseY: 170 },
      ].map((e, i): Enemy => ({
        x: e.x, y: e.baseY, vx: 1.2, vy: 0, baseY: e.baseY,
        patrolMin: e.x - 120, patrolMax: e.x + 120, state: "patrol",
        tint: tints[i % tints.length], hp: 1, alive: true, w: 70, h: 100,
      }));

      const notes: Note[] = [];
      for (let i = 0; i < 30; i++) {
        notes.push({ x: 300 + i * 140 + Math.random()*40, y: 200 + Math.random() * 220, collected: false, phase: Math.random()*Math.PI*2 });
      }

      const bossX = LEVEL_W - 400;
      const bossObj = {
        x: bossX, y: 220, vx: 0, vy: 0, w: 220, h: 320,
        hp: 10, onGround: false, jumpTimer: 60, attackTimer: 120, hitFlash: 0, alive: true,
      };

      const bows: Bow[] = [];
      const bossProjs: BossProj[] = [];

      const keys: Record<string, boolean> = {};
      const downKey = (e: KeyboardEvent) => {
        if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
        if (e.key === "ArrowUp" && !keys.ArrowUp) {
          if (player.onGround) { player.vy = -13; player.jumps = 1; player.onGround = false; }
          else if (player.jumps < 2) { player.vy = -11; player.jumps = 2; }
        }
        if (e.key === " " && !keys[" "]) {
          // throw bow
          if (bows.length === 0) {
            bows.push({ x: player.x + player.w/2, y: player.y + 40, vx: 9 * player.facing, t: 0, active: true, returning: false });
          }
          player.swordSwing = 15;
        }
        keys[e.key] = true;
      };
      const upKey = (e: KeyboardEvent) => { keys[e.key] = false; };
      window.addEventListener("keydown", downKey);
      window.addEventListener("keyup", upKey);

      let camX = 0;
      let life = 3, stars = 0, score = 0;
      let gameState: "play"|"win"|"lose" = "play";
      let tick = 0;

      const tintColor = (t: "yellow"|"red"|"black") =>
        t === "yellow" ? "rgba(255,210,60,0.55)" :
        t === "red"    ? "rgba(220,40,40,0.55)" :
                         "rgba(20,20,20,0.55)";

      const collidesRect = (a: {x:number;y:number;w:number;h:number}, b: {x:number;y:number;w:number;h:number}) =>
        a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;

      const loop = () => {
        if (stopped) return;
        tick++;
        // Input
        if (gameState === "play") {
          const speed = 4.5;
          if (keys.ArrowLeft) { player.vx = -speed; player.facing = -1; }
          else if (keys.ArrowRight) { player.vx = speed; player.facing = 1; }
          else player.vx *= 0.75;

          player.vy += GRAVITY;
          player.x += player.vx;
          player.y += player.vy;

          // Platform collisions
          player.onGround = false;
          for (const p of platforms) {
            if (player.x + player.w > p.x && player.x < p.x + p.w) {
              // landing from above
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
          if (player.swordSwing > 0) player.swordSwing--;

          // Camera
          camX = Math.max(0, Math.min(LEVEL_W - W, player.x - W/2 + player.w/2));

          // Enemies AI
          for (const e of enemies) {
            if (!e.alive) continue;
            const dx = (player.x + player.w/2) - (e.x + e.w/2);
            const dy = (player.y + player.h/2) - (e.y + e.h/2);
            const dist = Math.hypot(dx, dy);
            if (e.state === "patrol") {
              e.y = e.baseY + Math.sin(tick*0.05 + e.x)*8;
              e.x += e.vx;
              if (e.x < e.patrolMin) e.vx = Math.abs(e.vx);
              if (e.x > e.patrolMax) e.vx = -Math.abs(e.vx);
              if (dist < 220 && player.y > e.y) {
                e.state = "dive";
                e.vx = Math.sign(dx) * 3;
                e.vy = 4;
              }
            } else {
              e.x += e.vx;
              e.vy += 0.3;
              e.y += e.vy;
              if (e.y > 460) {
                e.state = "patrol";
                e.y = e.baseY; e.vy = 0; e.vx = 1.2 * (Math.random()<0.5?-1:1);
              }
            }
            // collide with player
            const eb = { x: e.x+10, y: e.y+10, w: e.w-20, h: e.h-20 };
            const pb = { x: player.x+15, y: player.y+10, w: player.w-30, h: player.h-20 };
            if (collidesRect(pb, eb) && player.invuln === 0) {
              // stomp?
              if (player.vy > 2 && player.y + player.h < e.y + e.h/2 + 20) {
                e.alive = false;
                player.vy = -10;
                score += 200;
              } else {
                life--; playBassHit();
                player.invuln = 90;
                player.vy = -8;
                player.vx = -player.facing * 6;
              }
            }
          }

          // Bows
          for (const b of bows) {
            b.t++;
            b.x += b.vx;
            if (!b.returning && (b.t > 40 || !keys[" "])) {
              b.returning = true;
            }
            if (b.returning) {
              const dx = (player.x + player.w/2) - b.x;
              b.vx = Math.sign(dx) * 10;
              if (Math.abs(dx) < 20) b.active = false;
            }
            for (const e of enemies) {
              if (!e.alive) continue;
              if (collidesRect({x:b.x-20,y:b.y-6,w:40,h:12}, {x:e.x+10,y:e.y+10,w:e.w-20,h:e.h-20})) {
                e.alive = false;
                score += 150;
              }
            }
            // boss
            if (bossObj.alive && collidesRect({x:b.x-20,y:b.y-6,w:40,h:12}, {x:bossObj.x+30,y:bossObj.y+20,w:bossObj.w-60,h:bossObj.h-40})) {
              if (bossObj.hitFlash === 0) {
                bossObj.hp--;
                bossObj.hitFlash = 20;
                score += 100;
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
              n.collected = true;
              stars++;
              score += 500;
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
              bossObj.vy = -15;
              bossObj.jumpTimer = 140 + Math.random()*60;
            }
            bossObj.attackTimer--;
            if (bossObj.attackTimer <= 0) {
              const dx = (player.x+player.w/2) - (bossObj.x+bossObj.w/2);
              const dy = (player.y+player.h/2) - (bossObj.y+80);
              const len = Math.hypot(dx,dy) || 1;
              for (let i=-1;i<=1;i++) {
                const ang = Math.atan2(dy,dx) + i*0.15;
                bossProjs.push({ x: bossObj.x+30, y: bossObj.y+80, vx: Math.cos(ang)*5, vy: Math.sin(ang)*5, t: 0 });
              }
              bossObj.attackTimer = 100;
            }
            if (bossObj.hitFlash > 0) bossObj.hitFlash--;

            // stomp boss
            const bb = { x: bossObj.x+30, y: bossObj.y+20, w: bossObj.w-60, h: bossObj.h-40 };
            const pb2 = { x: player.x+15, y: player.y+10, w: player.w-30, h: player.h-20 };
            if (collidesRect(pb2, bb) && player.invuln === 0) {
              if (player.vy > 2 && player.y + player.h < bossObj.y + 80) {
                if (bossObj.hitFlash === 0) {
                  bossObj.hp--; bossObj.hitFlash = 20; score += 200;
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
            if (p.t > 240 || p.x < 0 || p.x > LEVEL_W || p.y > H+50) bossProjs.splice(i,1);
            else if (player.invuln === 0 && collidesRect({x:p.x-10,y:p.y-10,w:20,h:20}, {x:player.x+15,y:player.y+10,w:player.w-30,h:player.h-20})) {
              life--; playBassHit(); player.invuln = 90; bossProjs.splice(i,1);
            }
          }

          if (life <= 0) gameState = "lose";
        }

        // ===== RENDER =====
        ctx.clearRect(0,0,W,H);
        // Sky gradient
        const sky = ctx.createLinearGradient(0,0,0,H);
        sky.addColorStop(0,"#7ec8ff"); sky.addColorStop(1,"#ffe4a8");
        ctx.fillStyle = sky; ctx.fillRect(0,0,W,H);

        // Parallax background image - tile with horizontal parallax
        const bgScale = H / bg.height;
        const bgW = bg.width * bgScale;
        const parX = -(camX * 0.4) % bgW;
        for (let x = parX - bgW; x < W; x += bgW) {
          ctx.drawImage(bg, x, 0, bgW, H);
        }
        // Distant clouds parallax
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        for (let i=0;i<8;i++){
          const cx = ((i*340) - camX*0.2) % (W+400);
          const x = cx < -200 ? cx + W+400 : cx;
          ctx.beginPath(); ctx.ellipse(x, 60+i*8, 50, 16, 0, 0, Math.PI*2); ctx.fill();
        }

        // Platforms (sandstone)
        for (const p of platforms) {
          const x = p.x - camX;
          if (x + p.w < 0 || x > W) continue;
          ctx.fillStyle = "#c89968";
          ctx.fillRect(x, p.y, p.w, p.h);
          ctx.fillStyle = "#a67a4d";
          ctx.fillRect(x, p.y, p.w, 6);
          ctx.strokeStyle = "rgba(80,50,20,0.4)"; ctx.lineWidth = 1;
          for (let bx = 0; bx < p.w; bx += 40) {
            ctx.strokeRect(x+bx, p.y, 40, Math.min(p.h, 30));
          }
        }

        // Notes
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

        // Boss (only appears after 20 000 points)
        if (bossObj.alive && score >= 20000) {
          const bx = bossObj.x - camX;
          if (bx + bossObj.w > -50 && bx < W+50) {
            ctx.save();
            if (bossObj.hitFlash > 0 && Math.floor(bossObj.hitFlash/3)%2===0) ctx.globalAlpha = 0.4;
            ctx.drawImage(boss, bx, bossObj.y, bossObj.w, bossObj.h);
            ctx.restore();
          }
        }

        // Boss projectiles
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

        // Enemies with rotation (tilt left by default, right when chasing right) + color tint
        for (const e of enemies) {
          if (!e.alive) continue;
          const x = e.x - camX;
          if (x + e.w < -100 || x > W + 100) continue;
          const angle = e.vx >= 0 ? Math.PI/2 : -Math.PI/2;
          ctx.save();
          ctx.translate(x + e.w/2, e.y + e.h/2);
          ctx.rotate(angle);
          ctx.drawImage(enemy, -e.w/2, -e.h/2, e.w, e.h);
          ctx.globalCompositeOperation = "source-atop";
          ctx.fillStyle = tintColor(e.tint);
          ctx.fillRect(-e.w/2, -e.h/2, e.w, e.h);
          ctx.restore();
        }

        // Player
        ctx.save();
        if (player.invuln > 0 && Math.floor(player.invuln/4)%2===0) ctx.globalAlpha = 0.4;
        const px = player.x - camX;
        if (player.facing === -1) {
          ctx.translate(px + player.w, player.y);
          ctx.scale(-1, 1);
          ctx.drawImage(hero, 0, 0, player.w, player.h);
        } else {
          ctx.drawImage(hero, px, player.y, player.w, player.h);
        }
        ctx.restore();

        // Bows (thrown archet) - draw as rotating line
        for (const b of bows) {
          const x = b.x - camX;
          ctx.save();
          ctx.translate(x, b.y);
          ctx.rotate(b.t * 0.5);
          ctx.strokeStyle = "#5a2d10"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(-22,0); ctx.lineTo(22,0); ctx.stroke();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(-20,2); ctx.lineTo(20,2); ctx.stroke();
          ctx.restore();
        }

        // Boss HP bar
        if (bossObj.alive && score >= 20000) {
          ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(W/2-150, 50, 300, 20);
          ctx.fillStyle = "#e63946"; ctx.fillRect(W/2-148, 52, 296*(bossObj.hp/10), 16);
          ctx.fillStyle = "#fff"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center";
          ctx.fillText("BOSS MÉTRONOME", W/2, 45); ctx.textAlign = "left";
        } else if (!bossObj.alive ? false : true) {
          // hint
          ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "right";
          ctx.fillText(`Boss à 20 000 pts (${Math.max(0,20000-score)} restants)`, W-12, H-12);
          ctx.textAlign = "left";
        }

        // Win / Lose overlay
        if (gameState !== "play") {
          ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0,0,W,H);
          ctx.fillStyle = "#ffd84d"; ctx.font = "bold 64px serif"; ctx.textAlign = "center";
          ctx.fillText(gameState === "win" ? "VICTOIRE !" : "GAME OVER", W/2, H/2);
          ctx.fillStyle = "#fff"; ctx.font = "20px sans-serif";
          ctx.fillText("Recharge la page pour rejouer", W/2, H/2+40);
          ctx.textAlign = "left";
        }

        setUi({ life, stars, score, bossHp: bossObj.hp, gameState });
        raf = requestAnimationFrame(loop);
      };
      loop();

      return () => {
        window.removeEventListener("keydown", downKey);
        window.removeEventListener("keyup", upKey);
      };
    })();

    return () => { stopped = true; cancelAnimationFrame(raf); };
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
        ← → se déplacer · ↑ sauter (↑↑ double saut) · ESPACE lancer l'archet (boomerang) · sauter sur les ennemis pour les écraser
      </div>
      <div className="w-full max-w-2xl">
        <iframe
          title="Bande son"
          width="100%"
          height="120"
          allow="autoplay"
          scrolling="no"
          frameBorder="no"
          src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/les-chiens-aboient&color=%23d97706&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false"
        />
        <div className="text-amber-100/60 text-xs text-center mt-1">
          ♪ Bande son : <a className="underline" href="https://soundcloud.com/mathieu-verlot/les-chiens-aboient" target="_blank" rel="noreferrer">Les chiens aboient — Mathieu Verlot</a>
        </div>
      </div>
    </div>
  );
}
