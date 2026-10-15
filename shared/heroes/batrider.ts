import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, push, stun } from './util';
import { dist } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Añade pilas de Sticky Napalm: ralentiza y amplifica el daño de Batrider. */
function napalm(u: Unit, e: Unit, n: number) {
  const a = find(u, 'batrider_sticky_napalm');
  if (!a || a.level <= 0 || n <= 0 || e.team === u.team) return;
  const cur = e.findMod('sticky_napalm', u);
  const max = val(a, 'unlimited_stacks') > 0 ? Infinity : val(a, 'max_stacks');
  const stacks = Math.min(max, (cur?.stacks ?? 0) + n);
  const m = debuff(u, e, a, {
    name: 'sticky_napalm', duration: dur(a, 'duration'), stacks, fx: 'slow',
    props: (mm) => ({ msSlow: mm.stacks * Math.abs(val(a, 'movement_speed_pct')) / 100 }),
    onTakeDamage(mm, ev) {
      if (ev.source !== u || ev.data?.napalm || ev.amount <= 0 || ev.ability === a) return;
      if (!ev.isAttack && !ev.ability) return;
      const v = mm.owner as Unit;
      const k = v.isHeroLike ? 1 : val(a, 'creep_damage_pct') / 100;
      damage(u, v, dmg(a, 'damage') * mm.stacks * k, 'magical', a, { noProc: true, data: { napalm: true } });
    },
  });
  if (m) { m.stacks = stacks; m.remaining = dur(a, 'duration'); e.refreshStats(); }
}

defineAbility({
  key: 'batrider_sticky_napalm', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'sticky_napalm', x: t.x, y: t.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      napalm(u, e, val(a, 'stacks_per_cast'));
      damage(u, e, val(a, 'application_damage') * (e.isHeroLike ? 1 : val(a, 'creep_damage_pct') / 100), 'magical', a, { data: { napalm: true } });
    }
  },
});

// Daño de aplicación de Napalm: sub-habilidad oculta de Valve, aquí es parte de Sticky Napalm.
defineAbility({ key: 'batrider_sticky_napalm_application_damage', target: 'passive', hidden: true, sub: true });

defineAbility({
  key: 'batrider_flamebreak', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'explosion_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'flamebreak', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'),
      left: Math.max(1, dist(u, t)), width: 0,
      onHit: () => false,
      onEnd(p) {
        const r = val(a, 'explosion_radius');
        u.w.emit({ n: 'nova', x: p.x, y: p.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, p.x, p.y, r)) {
          damage(u, e, dmg(a, 'damage_impact'), 'magical', a);
          if (!e.alive) continue;
          stun(u, e, val(a, 'stun_duration'), a);
          if (!e.has(ST.magicImmune)) push(e, e.x - p.x || 1, e.y - p.y, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'flamebreak_push');
          const dd = val(a, 'damage_duration');
          debuff(u, e, a, {
            name: 'flamebreak', duration: dd, interval: 1, fx: 'burn', props: { msSlow: val(a, 'slow') / 100 },
            onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage_per_second'), 'magical', a, { noProc: true }); },
          });
          napalm(u, e, val(a, 'napalm_stacks'));
        }
      },
    });
  },
});

defineAbility({
  key: 'batrider_firefly', target: 'none', ai: { role: 'aoe', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration');
    const every = val(a, 'tick_interval');
    const r = val(a, 'radius');
    const trail: { x: number; y: number }[] = [];
    const start = u.w.time;
    u.addMod({
      name: 'firefly', duration: d, fx: 'firefly', interval: every, states: ST.flying | ST.noCollision,
      // La velocidad crece hasta el máximo al final de la duración.
      props: () => ({ msPct: val(a, 'movement_speed_pct_total') / 100 * Math.min(1, (u.w.time - start) / d) }),
      onCreated() { trail.push({ x: u.x, y: u.y }); },
      onInterval() {
        const last = trail[trail.length - 1];
        if (!last || dist(last, u) > r * 0.5) trail.push({ x: u.x, y: u.y });
        u.w.cutTrees(u.x, u.y, val(a, 'tree_radius'));
        const hit = new Set<number>();
        for (const p of trail) {
          for (const e of u.w.enemiesIn(u.team, p.x, p.y, r)) {
            if (hit.has(e.id)) continue;
            hit.add(e.id);
            damage(u, e, dmg(a, 'damage_per_second') * every, 'magical', a, { noProc: true });
          }
        }
        u.refreshStats();
      },
    }, u, a);
  },
});

defineAbility({
  key: 'batrider_smoldering_resin', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'smoldering_resin',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (ev.missed || t.team === u.team || ev.fake) return;
      const per = ev.damage * ev.critMult * val(a, 'tick_attack_damage_pct') / 100;
      const ticks = val(a, 'total_ticks');
      debuff(u, t, a, {
        name: 'smoldering_resin', duration: ticks * val(a, 'tick_rate') + 0.05, interval: val(a, 'tick_rate'), fx: 'burn',
        onInterval(m) { damage(u, m.owner as Unit, per, 'physical', a, { noProc: true }); },
      });
      // Talento: los ataques ponen una pila de Napalm.
      const sn = find(u.kind === 'illusion' ? (u.owner as Unit) ?? u : u, 'batrider_sticky_napalm');
      if (sn && sn.level > 0 && u.kind === 'hero') napalm(u, t, val(sn, 'napalm_stacks_on_attack'));
    },
  }),
});

/** Arrastra a `e` detrás de `leader` a `distance` unidades. */
function lasso(a: AbilityInst, leader: Unit, e: Unit, duration: number, main: boolean) {
  const u = a.owner as Unit;
  const every = val(a, 'tick_rate');
  const perTick = dmg(a, 'damage') / Math.max(1, duration / every);
  let lx = u.x, ly = u.y;
  if (e.cast) e.w.interruptCast(e, true);
  return debuff(u, e, a, {
    name: main ? 'flaming_lasso' : 'flaming_lasso_tether', duration, fx: 'taunt', interval: every,
    states: ST.stunned, data: { strongPurgable: true },
    onTick(m) {
      const v = m.owner as Unit;
      // Un blink o teletransporte de Batrider rompe el lazo.
      if (!u.alive || Math.hypot(u.x - lx, u.y - ly) > val(a, 'break_distance') || !leader.alive) { m.remaining = 0.001; return; }
      lx = u.x; ly = u.y;
      const d = dist(v, leader);
      const want = main ? val(a, 'drag_distance') : 150;
      if (d > want) v.w.forceMove(v, leader.x + (v.x - leader.x) / d * want, leader.y + (v.y - leader.y) / d * want);
    },
    onInterval(m) { damage(u, m.owner as Unit, perTick, 'magical', a, { noProc: true }); },
  });
}

defineAbility({
  key: 'batrider_flaming_lasso', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'duration');
    if (!lasso(a, u, e, d, true)) return;
    // Scepter: también agarra al héroe aliado del objetivo más cercano, atado al primero.
    const r = val(a, 'grab_radius_scepter');
    if (hasScepter(u) && r > 0) {
      const second = u.w.alliesIn(e.team, e.x, e.y, r, { heroes: true })
        .filter((v) => v !== e && v.kind === 'hero').sort((x, y) => dist(x, e) - dist(y, e))[0];
      if (second) lasso(a, e, second, d, false);
    }
  },
});

defineHero('batrider', ['batrider_sticky_napalm', 'batrider_flamebreak', 'batrider_firefly', 'batrider_sticky_napalm_application_damage', 'batrider_smoldering_resin', 'batrider_flaming_lasso'], {
  build: ['null_talisman', 'arcane_boots', 'blink', 'force_staff', 'black_king_bar', 'shivas_guard', 'octarine_core'],
});
