import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, manaCostOf, val } from '../sim/abilities';
import { damage, kill } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, fear, idle, refund } from './lib/a7';
import { castDir, debuff, illusionsOf } from './util';

const DAGGER = 'spectre_spectral_dagger';
const DESOLATE = 'spectre_desolate';
const HAUNT = 'spectre_haunt';

interface PathPt { x: number; y: number; until: number }

/** Añade un punto al Shadow Path de Spectre. */
function pathPoint(u: Unit, x: number, y: number, life: number) {
  const a = abil(u, DAGGER);
  if (!a) return;
  const pts = (a.data.points ??= []) as PathPt[];
  const last = pts[pts.length - 1];
  if (last && Math.hypot(last.x - x, last.y - y) < 50 && last.until >= u.w.time + life - 0.5) return;
  pts.push({ x, y, until: u.w.time + life });
  u.w.emit({ n: 'shadow_path', x, y, r: val(a, 'path_radius'), d: life, t: u.team });
}

defineAbility({
  key: 'spectre_spectral_dagger', target: 'unitOrPoint', reflectable: true, ai: { role: 'nuke' },
  // Controlador del Shadow Path: acelera a Spectre y ralentiza a los enemigos que lo pisan.
  passive: (a) => ({
    name: 'shadow_path_ctl',
    onTick(m) {
      const u = m.owner as Unit;
      if (u.kind === 'illusion' || u.w.tickN % 3 !== 0) return;
      const pts = (a.data.points ?? []) as PathPt[];
      const now = u.w.time;
      a.data.points = pts.filter((p) => p.until > now);
      if (!a.data.points.length) return;
      const r = val(a, 'path_radius');
      const on = (v: Unit) => (a.data.points as PathPt[]).some((p) => Math.hypot(p.x - v.x, p.y - v.y) <= r);
      if (u.alive && on(u)) {
        u.addMod({
          name: 'shadow_path_buff', duration: val(a, 'buff_persistence'), fx: 'shadow_path',
          states: ST.flying | ST.noCollision, props: { msPct: val(a, 'bonus_movespeed') / 100 },
        }, u, a);
      }
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, 3000)) {
        if (!on(e)) continue;
        debuff(u, e, a, { name: 'shadow_path_slow', duration: 0.3, fx: 'slow', props: { msSlow: val(a, 'bonus_movespeed') / 100 } });
      }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const tx = t.unit ? t.unit.x : t.x, ty = t.unit ? t.unit.y : t.y;
    const [dx, dy] = castDir(u, tx, ty);
    const life = val(a, 'dagger_path_duration');
    u.w.addProjectile({
      kind: 'linear', fx: 'spectral_dagger', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'speed'), left: castRangeOf(a), width: val(a, 'dagger_radius') * 2,
      onThink(p) { pathPoint(u, p.x, p.y, life); u.w.addVision(u.team, p.x, p.y, val(a, 'vision_radius'), 0.2); },
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || (v.has(ST.magicImmune) && !a.def.bkbPierce)) return;
        damage(u, v, dmg(a, 'damage'), 'magical', a);
        if (!v.isHeroLike || !v.alive) return;
        // El héroe alcanzado deja rastro de Shadow Path.
        debuff(u, v, a, {
          name: 'spectral_dagger_trail', duration: val(a, 'hero_path_duration'), fx: 'shadow_path', interval: 0.2,
          onInterval(m) { const w = m.owner as Unit; pathPoint(u, w.x, w.y, val(a, 'hero_path_duration')); },
        });
      },
    });
  },
});

/** Ilusión de Spectre no controlable que persigue a `target`. */
function hauntIllusion(u: Unit, target: Unit, x: number, y: number, duration: number, outPct: number, inPct: number, kind: 'haunt' | 'step', travelSpeed = 0, msPct = 0) {
  const des = abil(u, DESOLATE);
  const bonus = des ? val(des, 'illusion_damage_outgoing') / 100 : 0;
  const il = u.w.spawnIllusion(u, x, y, duration, outPct + bonus, inPct);
  il.playerId = null;
  const atkRange = () => il.s.attackRange + il.radius + target.radius;
  il.addMod({
    name: 'spectre_illusion', persistent: true, fx: kind === 'haunt' ? 'haunt' : 'shadow_step',
    data: { kind, target: target.id, travel: travelSpeed > 0 },
    states: (travelSpeed > 0 ? ST.busy | ST.noCollision : 0) | (kind === 'haunt' ? ST.flying : 0),
    props: { msPct },
    onTick(m, dt) {
      const v = m.owner as Unit;
      if (!target.alive || !u.w.targetable(target)) { v.hp = 0; kill(v, null); return; }
      if (m.data.travel) {
        const d = Math.hypot(target.x - v.x, target.y - v.y);
        if (d > atkRange()) {
          const step = Math.min(d, travelSpeed * dt);
          v.facing = Math.atan2(target.y - v.y, target.x - v.x);
          u.w.forceMove(v, v.x + (target.x - v.x) / d * step, v.y + (target.y - v.y) / d * step);
          return;
        }
        m.data.travel = false;
        m.states = (m.states ?? 0) & ~(ST.busy | ST.noCollision);
        v.refreshStats();
      }
      if (v.order?.type !== 'attack') u.w.issueOrder(v, { type: 'attack', target: target.id });
    },
  }, u, null);
  u.w.issueOrder(il, { type: 'attack', target: target.id });
  return il;
}

defineAbility({
  key: 'spectre_shadow_step', target: 'unit', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    hauntIllusion(u, e, u.x, u.y, dur(a, 'duration'), (val(a, 'illusion_outgoing_damage') - 100) / 100,
      val(a, 'illusion_damage_incoming') / 100, 'step', val(a, 'move_speed'), val(a, 'bonus_move_speed_illusion_pct') / 100);
  },
});

defineAbility({
  key: 'spectre_dispersion', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  passive: (a) => ({
    name: 'dispersion',
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      const src = ev.source as Unit | null;
      if (ev.hpRemoval || ev.data?.dispersion || ev.data?.reflected || ev.amount <= 0 || (src && src.team === u.team)) return;
      let pct = val(a, 'damage_reflection_pct') / 100;
      if (u.findMod('dispersion_active')) pct *= 1 + val(a, 'activation_bonus_pct') / 100;
      const taken = ev.amount * pct;
      ev.amount -= taken;
      const lo = val(a, 'min_radius'), hi = val(a, 'max_radius');
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, hi)) {
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        const k = d <= lo ? 1 : Math.max(0, 1 - (d - lo) / (hi - lo));
        if (k > 0) damage(u, e, taken * k, ev.type, a, { noProc: true, data: { dispersion: true, reflected: true } });
      }
    },
  }),
  // Shard: activa más absorción y reflejo durante unos segundos.
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!hasShard(u)) { idle(a, 3); return; }
    a.cd = val(a, 'activation_cooldown') * (1 - u.s.cdr);
    u.mana -= val(a, 'activation_manacost');
    u.addMod({ name: 'dispersion_active', duration: val(a, 'activation_duration'), fx: 'dispersion' }, u, a);
  },
});

defineAbility({
  key: 'spectre_reality', target: 'point', castBeyond: true, levelWith: 1, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ils = illusionsOf(u).filter((i) => i.findMod('spectre_illusion'));
    if (!ils.length) { if (u.isBot) u.mana += manaCostOf(a); else refund(a); return; }
    ils.sort((p, q) => Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y));
    const il = ils[0];
    const kind = il.findMod('spectre_illusion')?.data.kind;
    const x = il.x, y = il.y, fx = u.x, fy = u.y;
    u.w.removeUnit(il);
    u.w.disjoint(u);
    u.w.teleport(u, x, y);
    u.w.emit({ n: 'blink', x: fx, y: fy, x2: u.x, y2: u.y, u: u.id, c: 'spectre' });
    // Scepter: la primera Reality sobre Haunt asusta a los enemigos cercanos.
    const h = abil(u, HAUNT);
    if (kind === 'haunt' && h && hasScepter(u) && !h.data.feared) {
      h.data.feared = true;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(h, 'fear_aoe'))) {
        fear(u, e, h, val(h, 'fear_duration'), u.x, u.y, { msSlow: val(h, 'fear_movespeed_slow') / 100 });
      }
    }
  },
});

defineAbility({
  key: 'spectre_desolate', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'desolate',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || (!t.isHeroLike && t.kind !== 'creep')) return;
      const alone = !u.w.alliesIn(t.team, t.x, t.y, val(a, 'radius')).some((x) => x !== t && x.kind !== 'ward');
      if (alone) damage(u, t, val(a, 'bonus_damage') * a.upg.dmg, 'pure', a, { noProc: true });
    },
  }),
});

defineAbility({
  key: 'spectre_haunt', target: 'none', ult: true, ai: { role: 'nuke', selfRadius: 1200 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    a.data.feared = false;
    u.w.emit({ n: 'haunt', x: u.x, y: u.y, u: u.id, t: u.team });
    for (const e of u.w.list) {
      if (!e.alive || e.kind !== 'hero' || e.team === u.team || !u.w.targetable(e)) continue;
      const ang = u.w.rng() * Math.PI * 2;
      hauntIllusion(u, e, e.x + Math.cos(ang) * 120, e.y + Math.sin(ang) * 120, dur(a, 'duration'),
        val(a, 'illusion_damage_outgoing') / 100, val(a, 'illusion_damage_incoming') / 100, 'haunt');
    }
  },
});

defineHero('spectre', ['spectre_spectral_dagger', 'spectre_shadow_step', 'spectre_dispersion', 'spectre_reality', 'spectre_desolate', 'spectre_haunt'], {
  build: ['wraith_band', 'power_treads', 'blade_mail', 'manta', 'black_king_bar', 'heart', 'butterfly', 'abyssal_blade'],
});

