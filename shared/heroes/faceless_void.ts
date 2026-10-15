import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, debuff, stun } from './util';
import { foes } from './lib/a3';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);
const hero = (u: Unit) => (u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u);
const controlledBy = (u: Unit, fv: Unit) => u === fv || u.owner === fv || (u.owner as Unit | null)?.owner === fv;

/** Bash de Time Lock: aturde, daña y repite el golpe tras un retardo. */
function timeLock(u: Unit, t: Unit, a: AbilityInst) {
  if (!t.alive) return;
  const d = t.isHeroLike ? val(a, 'duration') : val(a, 'duration_creep');
  stun(u, t, d, a);
  damage(u, t, dmg(a, 'bonus_damage'), 'magical', a);
  u.w.emit({ n: 'time_lock', x: t.x, y: t.y, u: t.id });
  u.w.after(val(a, 'delay'), () => {
    if (u.alive && t.alive && u.w.targetable(t)) launchAttack(u, t, true);
  });
}

defineAbility({
  key: 'faceless_void_time_walk', target: 'point', castBeyond: true, ai: { role: 'escape' },
  castRange: (a) => val(a, 'range'),
  // Recuerda el daño recibido para devolverlo al lanzar.
  passive: () => ({
    name: 'time_walk_backtrack', data: { log: [] as [number, number][] },
    // Talento: probabilidad de deshacer por completo un golpe (Backtrack).
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (ev.hpRemoval || !hasTalent(u, 'special_bonus_unique_faceless_void_4')) return;
      if (u.w.rng() < 0.2) { ev.amount = 0; u.w.emit({ n: 'backtrack', x: u.x, y: u.y, u: u.id }); }
    },
    onTakeDamage(m, ev) {
      const u = m.owner as Unit;
      if (ev.amount > 0) m.data.log.push([u.w.time, ev.amount]);
      if (m.data.log.length > 200) m.data.log.splice(0, 100);
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const go = Math.min(val(a, 'range') * a.upg.range + u.s.castRange, Math.hypot(t.x - u.x, t.y - u.y) || val(a, 'range'));
    const back = val(a, 'backtrack_duration');
    const log = (a.passiveMod?.data.log ?? []) as [number, number][];
    const amount = log.filter(([tm]) => u.w.time - tm <= back).reduce((s, [, v]) => s + v, 0);
    if (a.passiveMod) a.passiveMod.data.log = [];
    heal(u, amount);
    u.w.disjoint(u);
    a.data.from = { x: u.x, y: u.y };
    u.w.emit({ n: 'time_walk', x: u.x, y: u.y, x2: u.x + dx * go, y2: u.y + dy * go, u: u.id });
    dash(u, u.x + dx * go, u.y + dy * go, val(a, 'speed'), a, {
      name: 'time_walk',
      onArrive: () => {
        // Scepter: al aterrizar aplica Time Lock alrededor y abre Reverse Time Walk.
        if (!hasScepter(u)) return;
        const lock = ab(u, 'faceless_void_time_lock');
        if (lock) for (const e of foes(u, u.x, u.y, val(a, 'radius'), lock)) timeLock(u, e, lock);
        u.addMod({ name: 'time_walk_reverse_window', duration: 1.5, data: { from: a.data.from } }, u, a);
      },
    });
  },
});

defineAbility({
  key: 'faceless_void_time_dilation', target: 'none', ai: { role: 'disable', selfRadius: 600 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const d = dur(a, 'duration');
    let total = 0;
    u.w.emit({ n: 'time_dilation', x: u.x, y: u.y, r, u: u.id, t: u.team });
    for (const e of foes(u, u.x, u.y, r, a)) {
      const onCd = e.abilities.filter((x) => x.cd > 0 && x.level > 0).length;
      const stacks = 1 + onCd;
      total += stacks;
      const m = debuff(u, e, a, {
        name: 'time_dilation', duration: d, stacks, fx: 'slow', interval: 1,
        props: (mm) => ({ msSlow: mm.stacks * val(a, 'slow') / 100, attackSlow: mm.stacks * val(a, 'attack_slow_tooltip_only') }),
        onInterval(mm) { damage(u, mm.owner as Unit, mm.stacks * dmg(a, 'damage_per_stack'), 'magical', a, { noProc: true }); },
        onTick(mm, dt) {
          const v = mm.owner as Unit;
          // Los enfriamientos avanzan más despacio; la duración se pausa dentro de Chronosphere.
          const k = val(a, 'cooldown_percentage') / 100;
          for (const x of v.abilities) if (x.cd > 0) x.cd += dt * k;
          if (v.findMod('chronosphere_freeze')) mm.remaining += dt;
        },
      });
      if (m) { m.stacks = stacks; e.refreshStats(); }
    }
    // Shard: Void gana velocidad según las cargas aplicadas, que se desvanecen.
    if (hasShard(u) && total > 0) {
      u.addMod({
        name: 'time_dilation_self', duration: d, stacks: total, fx: 'haste',
        props: (m) => {
          const k = m.duration > 0 ? Math.max(0, m.remaining / m.duration) : 0;
          return { msPct: m.stacks * k * val(a, 'self_movespeed_tooltip') / 100, attackSpeed: m.stacks * k * val(a, 'self_attackspeed_tooltip') };
        },
        interval: 0.25, onInterval(m) { (m.owner as Unit).refreshStats(); },
      }, u, a);
    }
  },
});

defineAbility({
  key: 'faceless_void_time_lock', target: 'passive',
  passive: (a) => ({
    name: 'time_lock',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (ev.fake || t.team === u.team || (!t.isHeroLike && t.kind !== 'creep' && t.kind !== 'summon')) return;
      if (u.w.rng() >= val(a, 'chance_pct') / 100) return;
      timeLock(u, t, a);
    },
  }),
});

defineAbility({
  key: 'faceless_void_time_walk_reverse', target: 'none', ai: { role: 'escape', selfRadius: 0 },
  hidden: (a) => !(a.owner as Unit).findMod('time_walk_reverse_window'),
  // Los bots la usan si al aterrizar están en apuros.
  passive: () => ({
    name: 'reverse_bot', interval: 0.2,
    onInterval(m) {
      const u = m.owner as Unit;
      const a = m.ability as AbilityInst;
      if (!u.isBot || !u.findMod('time_walk_reverse_window') || u.w.castCheck(u, a)) return;
      if (u.hp / u.s.maxHp < 0.5 || u.ai?.retreat) u.w.issueOrder(u, { type: 'cast', slot: a.slot });
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const win = u.findMod('time_walk_reverse_window');
    if (!win) return;
    const from = win.data.from as { x: number; y: number };
    u.removeMod(win);
    u.w.disjoint(u);
    dash(u, from.x, from.y, val(a, 'speed'), a, { name: 'time_walk' });
  },
});

// Innata: los proyectiles de ataque enemigos se frenan cerca de Void y sus aliados.
defineAbility({
  key: 'faceless_void_distortion_field', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'distortion_field',
    onTick(m) {
      const u = m.owner as Unit;
      const near = val(a, 'friendly_hero_distance'), dist = val(a, 'slow_distance_max');
      const k = 1 - val(a, 'attack_projectile_slow') / 100;
      for (const p of u.w.projectiles) {
        const pp = p as typeof p & { distorted?: boolean };
        if (pp.distorted || p.kind !== 'track' || !p.fx.startsWith('attack') || p.team === u.team) continue;
        const t = p.target as Unit | null;
        if (!t || t.team !== u.team || !(t === u || t.isHeroLike) || Math.hypot(t.x - u.x, t.y - u.y) > near) continue;
        if (Math.hypot(t.x - p.x, t.y - p.y) > dist) continue;
        pp.distorted = true;
        p.speed *= k;
      }
    },
  }),
});

/** Congela a una unidad: no puede actuar y se revela si era invisible. */
function freezeSpec(fv: Unit, a: AbilityInst): ModSpec {
  return {
    name: 'chronosphere_freeze', duration: 0.25, states: ST.stunned | ST.revealed, fx: 'chronosphere', purgable: false,
    onCreated(m) {
      const v = m.owner as Unit;
      v.atk.phase = 0;
      if (v.cast) v.w.interruptCast(v, true);
    },
    data: { by: fv.id, ab: a.key },
  };
}

defineAbility({
  key: 'faceless_void_chronosphere', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const d = dur(a, 'duration');
    const w = u.w;
    w.emit({ n: 'chronosphere', x: t.x, y: t.y, r, d, t: u.team });
    w.addVision(u.team, t.x, t.y, val(a, 'vision_radius'), d);
    const apply = () => {
      for (const v of w.unitsIn(t.x, t.y, r, (x) => x.kind !== 'fountain' && x.kind !== 'throne' && x.kind !== 'kobold' && x.kind !== 'orb')) {
        if (controlledBy(v, hero(u))) {
          if (v === u || v.owner === u) {
            v.addMod({
              name: 'chronosphere_haste', duration: 0.25, fx: 'haste',
              props: { msFixed: 1000, attackSpeed: val(a, 'bonus_attack_speed') },
            }, u, a);
          }
          continue;
        }
        if (v.has(ST.invulnerable) && v.team === u.team) continue;
        const m = v.team === u.team ? v.addMod(freezeSpec(u, a), u, a) : debuff(u, v, a, freezeSpec(u, a));
        if (m) m.remaining = Math.max(m.remaining, 0.2);
      }
    };
    apply();
    w.addZone({ fx: 'chronosphere', x: t.x, y: t.y, r, team: u.team, interval: 0.1, duration: d, onInterval: apply });
  },
});

defineHero('faceless_void', ['faceless_void_time_walk', 'faceless_void_time_dilation', 'faceless_void_time_lock', 'faceless_void_time_walk_reverse', 'faceless_void_distortion_field', 'faceless_void_chronosphere'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'mask_of_madness', 'black_king_bar', 'mjollnir', 'butterfly', 'satanic'],
  upgrades: [
    { slot: 0, key: 'range', amount: 60, max: 5, label: 'Time Walk: +60 de alcance' },
    { slot: 0, key: 'backtrack_duration', amount: 0.25, max: 4, label: 'Time Walk: +0,25 s de retroceso' },
    { slot: 1, key: 'damage_per_stack', amount: 3, max: 5, label: 'Time Dilation: +3 daño por carga' },
    { slot: 2, key: 'chance_pct', amount: 2, max: 5, label: 'Time Lock: +2% de probabilidad' },
    { slot: 2, key: 'bonus_damage', amount: 8, max: 5, label: 'Time Lock: +8 daño' },
    { slot: 5, key: 'duration', amount: 0.25, max: 4, label: 'Chronosphere: +0,25 s de duración' },
    { slot: 5, key: 'radius', amount: 25, max: 4, label: 'Chronosphere: +25 de radio' },
  ],
});
