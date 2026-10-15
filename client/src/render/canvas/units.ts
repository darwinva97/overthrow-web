// Cuerpo de las unidades en el modo 2D: fichas de héroe, siluetas de creeps e invocaciones y
// estructuras. Todo sale de sprites precalculados (canvas/sprites.ts, canvas/creatures.ts); en
// cada frame solo se calcula la animación (paso, ataque, lanzamiento, golpe, muerte) y se copian
// los sprites con la transformación adecuada. No hay save/restore, clip ni reservas por frame.
// Los estados encima de la unidad, proyectiles y poderes los pinta canvas/effects.ts.
import { HEROES, UNITS } from '../../../../shared/data';
import { ST, type Fx } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { ORB_COLOR } from '../fxstyle';
import { TEAM_NEUTRAL, teamColor, type View } from '../types';
import { creatureDef, creatureSprite, type CreatureDef } from './creatures';
import {
  TOKEN, baseSprite, castIcon, darkDisk, fountainSprite, glow, heroSprites, illusionSprite, koboldKingSprite,
  orbSprite, ring, shadow, slashSprite, spriteGen, throneSprite, weaponSprite, whiteDisk, type HeroSprites, type Sprite,
} from './sprites';

/** Dónde quedó dibujada la unidad (con saltos o elevaciones aplicados) y su radio visual. */
export interface Drawn { x: number; y: number; r: number }

/** Estado de animación de una unidad (persiste entre frames; el snapshot trae objetos nuevos cada vez). */
interface Anim {
  id: number;
  /** Frame en que se dibujó por última vez. */
  seen: number;
  // Copia de lo último que se vio, para seguir pintándola mientras muere.
  k: string; n: string; t: number; x: number; y: number; f: number; r: number;
  hp: number;
  flash: number;
  atk: number; rel: number; wasA: boolean;
  cast: number; wasC: number;
  walk: number; spd: number;
  dead: number;
  // Sprites resueltos (se vuelven a pedir si cambia la generación o el color de equipo).
  gen: number; team: string; own: boolean;
  hs: HeroSprites | null; body: Sprite | null; weapon: Sprite | null; melee: boolean; hero: boolean;
  def: CreatureDef | null; spr: Sprite | null; base: Sprite | null;
  lift: number;
  drawn: Drawn;
}

const DEATH = 0.9;
const FLASH = 0.13;
const TAU = Math.PI * 2;
const NEUTRAL_RIM = '#7a6446';
const CAST = '#f6cf7c';

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export class UnitPainter {
  private clock = 0;
  private dt = 0;
  private frame = 0;
  private anims = new Map<number, Anim>();
  private dying: Anim[] = [];
  // Transformación mundo → dispositivo y rectángulo visible.
  private m = 1; private ox = 0; private oy = 0;
  private x0 = 0; private y0 = 0; private x1 = 0; private y1 = 0;
  private dash = [0, 0];
  private sweep = (a: Anim, id: number) => {
    if (a.seen < this.frame - 90 && a.dead < 0) this.anims.delete(id);
  };
  /** Estadísticas del último frame. */
  drawnCount = 0; culled = 0;

  /** Al empezar el frame: transformación de mundo (x' = m·x + ox) y área visible en mundo. */
  begin(m: number, ox: number, oy: number, x0: number, y0: number, x1: number, y1: number, clock: number) {
    this.frame++;
    this.dt = Math.min(0.1, Math.max(0, clock - this.clock));
    this.clock = clock;
    this.m = m; this.ox = ox; this.oy = oy;
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
    this.drawnCount = 0; this.culled = 0;
    if (this.frame % 120 === 0) this.anims.forEach(this.sweep);
  }

  /** Eventos del servidor que afectan a la animación (muerte, golpe, lanzamiento…). */
  onFx(f: Fx, _v: View) {
    if (f.n === 'death' && f.u !== undefined) {
      const a = this.anims.get(f.u);
      if (a && a.dead < 0) { a.dead = this.clock; this.dying.push(a); }
    }
  }

  /** Unidades que acaban de morir y ya no vienen en el snapshot: caen y se desvanecen. */
  drawDying(c: CanvasRenderingContext2D) {
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const a = this.dying[i];
      const t = (this.clock - a.dead) / DEATH;
      if (t >= 1 || a.dead < 0) {
        a.dead = -1;
        this.dying[i] = this.dying[this.dying.length - 1]; this.dying.pop();
        continue;
      }
      // Si sigue en el snapshot, se pinta desde draw() con la misma animación.
      if (a.seen >= this.frame - 1) continue;
      if (!this.visible(a.x, a.y, 80)) continue;
      this.paintBody(c, a, a.x, a.y, a.f, 0, 1, 0, 0, 0, 0, t);
    }
    this.reset(c);
  }

  /** Dibuja la unidad; devuelve su posición dibujada o null si no se dibuja. */
  draw(c: CanvasRenderingContext2D, v: View, u: VUnit, px: number, clock: number): Drawn | null {
    if (clock !== this.clock) { this.dt = Math.min(0.1, Math.max(0, clock - this.clock)); this.clock = clock; }
    if (u.s & ST.hidden) return null;
    const a = this.track(u);
    let x = u.px, y = u.py;
    switch (u.k) {
      case 'throne': return this.drawThrone(c, a, x, y);
      case 'orb': return this.drawOrb(c, v, u, a, x, y, px);
      case 'fountain': return this.drawFountain(c, v, u, a, x, y);
    }
    const hero = u.k === 'hero' || u.k === 'illusion' || (u.k === 'summon' && HEROES[u.n] !== undefined);
    const margin = hero ? 90 : u.r * 2 + 60;
    if (!this.visible(x, y, margin)) { this.culled++; return null; }
    this.resolve(v, u, a, hero);

    // Elevación: ciclón y voladores.
    const fx = u.fx;
    let lift = 0;
    if ((u.s & ST.flying) !== 0) lift = 28 + Math.sin(this.clock * 2.4 + u.i) * 3;
    if (fx && fx.includes('cyclone')) lift = 40 + Math.sin(this.clock * 6) * 8;
    a.lift = lift;

    // Transparencia: invisible, etéreo, Doppelganger.
    let alpha = 1;
    if (fx) {
      if (fx.includes('invis')) alpha = 0.38 + Math.sin(this.clock * 5 + u.i) * 0.06;
      else if (fx.includes('ethereal')) alpha = 0.5;
      else if (fx.includes('doppel')) alpha = 0.45;
    }
    if ((u.s & ST.invisible) !== 0 && alpha > 0.45) alpha = 0.42;

    // Paso: balanceo y escala según la velocidad.
    const wk = Math.min(1.2, a.spd / 300);
    const step = Math.sin(a.walk);
    const bob = Math.abs(step) * 3.2 * wk;
    const sway = step * 0.07 * wk;
    let scale = 1 + Math.abs(step) * 0.025 * wk;

    // Lanzamiento: pulso (punto de lanzamiento) o latido lento (canalizando).
    if (u.c) {
      const ct = this.clock - a.cast;
      scale *= u.c === 1 ? 1 + 0.07 * Math.sin(ct * 22) * Math.min(1, ct * 6) : 1 + 0.03 * Math.sin(ct * 6);
    }

    const dying = a.dead >= 0 ? clamp01((this.clock - a.dead) / DEATH) : 0;
    const d = this.paintBody(c, a, x, y, u.pf, lift + bob, scale, sway, alpha, u.c ?? 0, u.a ? 1 : 0, dying, u, v, px);
    this.drawnCount++;
    return d;
  }

  // -------------------------------------------------------------------------------------------

  private visible(x: number, y: number, m: number) {
    return x > this.x0 - m && x < this.x1 + m && y > this.y0 - m && y < this.y1 + m;
  }

  private track(u: VUnit): Anim {
    let a = this.anims.get(u.i);
    if (!a || a.n !== u.n) {
      a = {
        id: u.i, seen: 0, k: u.k, n: u.n, t: u.t, x: u.px, y: u.py, f: u.pf, r: u.r, hp: u.h,
        flash: -9, atk: -9, rel: -9, wasA: false, cast: -9, wasC: 0, walk: 0, spd: 0, dead: -1,
        gen: -1, team: '', own: false, hs: null, body: null, weapon: null, melee: true, hero: false,
        def: null, spr: null, base: null, lift: 0, drawn: { x: 0, y: 0, r: 0 },
      };
      this.anims.set(u.i, a);
    }
    if (a.seen >= this.frame - 3 && u.h < a.hp - 0.5 && this.clock - a.flash > 0.3) a.flash = this.clock;
    if (a.dead >= 0 && this.clock - a.dead > DEATH && u.h > 0) a.dead = -1;
    a.hp = u.h;
    a.k = u.k; a.t = u.t; a.x = u.px; a.y = u.py; a.f = u.pf; a.r = u.r;
    const atk = u.a === 1;
    if (atk && !a.wasA) a.atk = this.clock;
    if (!atk && a.wasA) a.rel = this.clock;
    a.wasA = atk;
    const cst = u.c ?? 0;
    if (cst && cst !== a.wasC) a.cast = this.clock;
    a.wasC = cst;
    a.spd += (u.speed - a.spd) * Math.min(1, this.dt * 8);
    if (a.spd < 4) a.spd = 0;
    a.walk = (a.walk + this.dt * a.spd / 48) % (Math.PI * 64);
    a.seen = this.frame;
    return a;
  }

  /** Resuelve (y guarda) los sprites de la unidad. */
  private resolve(v: View, u: VUnit, a: Anim, hero: boolean) {
    const team = teamColor(v, u.t);
    const own = u.o === 1;
    const g = spriteGen();
    if (a.gen === g && a.team === team && a.own === own && (!a.hs || a.hs.face >= 2) && a.hero === hero) {
      if (a.hs) a.body = u.il ? illusionSprite(u.n, team, a.hs) : a.hs.body;
      return;
    }
    a.gen = g; a.team = team; a.own = own; a.hero = hero;
    if (hero) {
      a.hs = heroSprites(u.n, team, own);
      a.body = u.il ? illusionSprite(u.n, team, a.hs) : a.hs.body;
      a.melee = HEROES[u.n]?.melee ?? true;
      a.weapon = weaponSprite(a.melee, team);
      a.def = null; a.spr = null; a.base = null;
    } else {
      a.hs = null; a.body = null; a.weapon = null;
      a.def = creatureDef(u.n, u.k);
      a.spr = creatureSprite(a.def, u.r * a.def.k);
      const rim = u.k === 'creep' || team === TEAM_NEUTRAL ? NEUTRAL_RIM : team;
      a.base = u.k === 'kobold' ? baseSprite(50, '#e0b050') : baseSprite(Math.max(14, u.r * 1.25), rim);
      a.melee = UNITS[u.n]?.melee ?? true;
      if (u.k === 'kobold') a.spr = koboldKingSprite();
    }
  }

  /** Coloca el sistema de coordenadas en (x, y) de mundo, girado rot y escalado k. */
  private place(c: CanvasRenderingContext2D, x: number, y: number, rot: number, k: number) {
    const m = this.m * k;
    if (rot === 0) c.setTransform(m, 0, 0, m, this.ox + this.m * x, this.oy + this.m * y);
    else {
      const cs = Math.cos(rot) * m, sn = Math.sin(rot) * m;
      c.setTransform(cs, sn, -sn, cs, this.ox + this.m * x, this.oy + this.m * y);
    }
  }
  private reset(c: CanvasRenderingContext2D) {
    c.setTransform(this.m, 0, 0, this.m, this.ox, this.oy);
    c.globalAlpha = 1;
  }
  private spr(c: CanvasRenderingContext2D, s: Sprite, dx = 0, dy = 0) { c.drawImage(s.c, s.x + dx, s.y + dy, s.w, s.h); }
  /** Sprite de radio 1 escalado a r, centrado en (x, y) del sistema actual. */
  private unit(c: CanvasRenderingContext2D, s: Sprite, x: number, y: number, r: number) {
    c.drawImage(s.c, x + s.x * r, y + s.y * r, s.w * r, s.h * r);
  }

  /**
   * Ficha de héroe o silueta de criatura con toda su animación.
   * h: altura sobre el suelo; die: progreso de la muerte (0 = viva).
   */
  private paintBody(c: CanvasRenderingContext2D, a: Anim, x: number, y: number, pf: number, h: number, scale: number,
    sway: number, alpha: number, cast: number, attacking: number, die: number, u?: VUnit, v?: View, px = 1): Drawn {
    const hero = a.hero;
    const R = hero ? TOKEN.edge : a.r * 1.25;
    const baseAlpha = (alpha || 1) * (die > 0 ? (1 - die) ** 1.4 : 1);
    const cs = Math.cos(pf), sn = Math.sin(pf);

    // Ataque: cuerpo a cuerpo prepara y suelta un tajo; a distancia, retroceso.
    let lunge = 0, wRot = 0, wOff = 0, slashA = 0, slashRot = 0, muzzle = 0;
    const tA = this.clock - a.atk, tR = this.clock - a.rel;
    if (attacking) {
      const p = clamp01(tA / 0.3);
      if (a.melee) { wRot = -1.1 * easeOut(p); lunge = -4 * p; slashA = 0.15 + 0.35 * p; slashRot = -1.3 + 0.4 * p; }
      else { wOff = -8 * easeOut(p); lunge = -6 * easeOut(p); }
    } else if (tR < 0.22) {
      const q = tR / 0.22;
      if (a.melee) { wRot = -1.1 + 2.2 * easeOut(q); lunge = 12 * Math.sin(q * Math.PI); slashA = (1 - q) * 0.95; slashRot = -0.9 + 1.6 * easeOut(q); }
      else { wOff = -8 + 8 * easeOut(clamp01(q * 3)); lunge = -6 * (1 - q); muzzle = 1 - q; }
    }
    if (!hero) { wRot = 0; wOff = 0; slashA *= 0.7; }

    // Muerte: cae (se inclina y encoge) y se hunde.
    let tilt = 0;
    if (die > 0) { scale *= 1 - 0.3 * die; tilt = die * die * 1.1; h -= die * 10; }

    const X = x + cs * lunge, Y = y + sn * lunge - h;
    const gy = y; // suelo

    // Las fichas y peanas llevan la sombra horneada; al elevarse se añade otra en el suelo.
    if (h > 8) {
      const sh = Math.max(0.55, 1 - h / 90);
      this.reset(c);
      c.globalAlpha = baseAlpha * (0.9 - Math.min(0.4, h / 120));
      this.unit(c, shadow(), x + 4 + h * 0.12, gy + 7 + h * 0.18, R * 1.05 * sh);
    }

    // Peana de criaturas: en el suelo.
    if (!hero && a.base) {
      c.globalAlpha = baseAlpha;
      this.place(c, x, gy, 0, 1 - 0.2 * die);
      this.spr(c, a.base);
    }

    // Halo de lanzamiento.
    if (cast && die === 0) {
      const ct = this.clock - a.cast;
      const k = cast === 1 ? 1 + 0.1 * Math.sin(ct * 22) : 1 + 0.06 * Math.sin(ct * 5);
      this.reset(c);
      c.globalAlpha = baseAlpha * (cast === 1 ? Math.min(1, ct * 5) : 0.75);
      this.unit(c, glow(CAST), X, Y, R * 1.9 * k);
      c.globalAlpha = baseAlpha * 0.8;
      this.unit(c, ring(CAST), X, Y, R + 7 + (cast === 1 ? (ct * 30) % 14 : 4));
    }

    if (hero) {
      // Arma (bajo la ficha, para que la empuñadura quede tapada).
      if (a.weapon && die === 0) {
        c.globalAlpha = baseAlpha;
        this.place(c, X, Y, pf + wRot, scale);
        this.spr(c, a.weapon, wOff, 0);
        if (muzzle > 0) {
          c.globalAlpha = baseAlpha * muzzle;
          this.unit(c, glow('#fff1c2'), R + 22, 0, 14);
        }
      }
      if (a.body) {
        c.globalAlpha = baseAlpha;
        this.place(c, X, Y, sway + tilt, scale);
        this.spr(c, a.body);
      }
    } else if (a.spr) {
      const fixed = a.k !== 'kobold' && a.def?.fixed;
      c.globalAlpha = baseAlpha;
      this.place(c, X, Y, (fixed ? 0 : pf) + sway * 0.6 + tilt, scale);
      this.spr(c, a.spr);
    }

    // Golpe recibido: destello blanco.
    const ft = this.clock - a.flash;
    if (ft < FLASH && die === 0) {
      c.globalAlpha = baseAlpha * 0.42 * (1 - ft / FLASH);
      this.place(c, X, Y, 0, scale);
      this.unit(c, whiteDisk(), 0, 0, hero ? TOKEN.team : R);
    }
    // Muerte: se oscurece.
    if (die > 0) {
      c.globalAlpha = baseAlpha * Math.min(0.7, die * 1.2);
      this.place(c, X, Y, 0, scale);
      this.unit(c, darkDisk(), 0, 0, hero ? TOKEN.team : R * 0.9);
    }
    // Tajo cuerpo a cuerpo.
    if (slashA > 0.02 && die === 0) {
      c.globalAlpha = baseAlpha * slashA;
      this.place(c, X, Y, pf + slashRot, hero ? scale : (a.r * 1.4) / 50);
      this.spr(c, slashSprite());
    }

    if (u && v && die === 0) {
      // Icono de lo que lanza.
      if (cast && u.ck) {
        const ic = castIcon(u.ck);
        if (ic) {
          c.globalAlpha = Math.max(0.6, baseAlpha);
          this.place(c, X + R * 0.78, Y - R * 0.78, 0, 1);
          this.spr(c, ic);
        }
      }
      // Ratón encima.
      if (v.hover === u.i) {
        c.globalAlpha = 0.75;
        this.reset(c);
        c.globalAlpha = 0.75;
        this.unit(c, ring('#ffffff'), X, Y, R + 8);
      }
    }
    this.reset(c);
    const d = a.drawn;
    d.x = X; d.y = Y; d.r = hero ? 34 : a.r * 1.3;
    void px;
    return d;
  }

  // -------------------------------------------------------------------------------------------
  // Estructuras

  private drawThrone(c: CanvasRenderingContext2D, a: Anim, x: number, y: number): Drawn | null {
    if (!this.visible(x, y, 220)) { this.culled++; return null; }
    this.reset(c);
    c.globalAlpha = 0.28 + 0.1 * Math.sin(this.clock * 1.6);
    this.unit(c, glow('#ffd36a'), x, y, 230);
    c.globalAlpha = 1;
    this.place(c, x, y, 0, 1);
    this.spr(c, throneSprite());
    // Destello que recorre el oro.
    const k = (this.clock * 0.35) % 1;
    c.globalAlpha = Math.sin(k * Math.PI) * 0.5;
    this.unit(c, ring('#fff1c2'), 0, 0, 60 + k * 58);
    this.reset(c);
    this.drawnCount++;
    const d = a.drawn; d.x = x; d.y = y; d.r = 110;
    return d;
  }

  private drawFountain(c: CanvasRenderingContext2D, v: View, u: VUnit, a: Anim, x: number, y: number): Drawn | null {
    if (!this.visible(x, y, 180)) { this.culled++; return null; }
    const team = teamColor(v, u.t);
    this.reset(c);
    c.globalAlpha = 0.55;
    this.unit(c, glow(team), x, y, 170);
    c.globalAlpha = 1;
    this.place(c, x, y, 0, 1);
    this.spr(c, fountainSprite(team));
    // Ondas en el agua.
    const rs = ring('#ffffff');
    for (let i = 0; i < 2; i++) {
      const k = (this.clock * 0.45 + i * 0.5) % 1;
      c.globalAlpha = (1 - k) * 0.55;
      this.unit(c, rs, 0, 0, 24 + k * 46);
    }
    this.reset(c);
    this.drawnCount++;
    const d = a.drawn; d.x = x; d.y = y; d.r = 62;
    return d;
  }

  private drawOrb(c: CanvasRenderingContext2D, v: View, u: VUnit, a: Anim, x: number, y: number, px: number): Drawn | null {
    if (!this.visible(x, y, 260)) { this.culled++; return null; }
    let o = null;
    for (let i = 0; i < v.orbs.length; i++) if (v.orbs[i].i === u.i) { o = v.orbs[i]; break; }
    const rar = o?.r ?? 'common';
    const col = ORB_COLOR[rar] ?? '#7fe0ff';
    this.reset(c);
    // Zona de captura y progreso de cada equipo.
    c.strokeStyle = col; c.globalAlpha = 0.55; c.lineWidth = 3 * px;
    this.dash[0] = 14 * px; this.dash[1] = 10 * px;
    c.setLineDash(this.dash);
    c.lineDashOffset = -this.clock * 40 * px;
    c.beginPath(); c.arc(x, y, 220, 0, TAU); c.stroke();
    c.setLineDash(EMPTY); c.lineDashOffset = 0;
    c.globalAlpha = 1;
    if (o) for (let i = 0; i < o.p.length; i++) {
      const pr = o.p[i];
      c.strokeStyle = teamColor(v, pr[0]); c.lineWidth = 12 * px;
      c.beginPath(); c.arc(x, y, 220, -Math.PI / 2, -Math.PI / 2 + (pr[1] / v.captureTime) * TAU); c.stroke();
    }
    const pulse = 1 + Math.sin(this.clock * 4) * 0.08;
    const bob = Math.sin(this.clock * 2.2) * 6;
    c.globalAlpha = 0.5;
    this.unit(c, shadow(), x + 4, y + 10, 26 - bob * 0.6);
    c.globalAlpha = 0.9;
    this.unit(c, glow(col), x, y - 14 - bob, 80 * pulse);
    c.globalAlpha = 1;
    this.place(c, x, y - 14 - bob, Math.sin(this.clock * 1.3) * 0.12, 0.9 * pulse);
    this.spr(c, orbSprite(rar));
    this.reset(c);
    this.drawnCount++;
    const d = a.drawn; d.x = x; d.y = y - 14; d.r = 30;
    return d;
  }
}

const EMPTY: number[] = [];
