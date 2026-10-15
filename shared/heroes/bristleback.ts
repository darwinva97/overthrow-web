import { defineAbility, defineHero, dmg, hasScepter, isItem, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff } from './util';
import { addTimedStack, dist, lockSub, pruneTimedStack, unlockSub } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Ángulo (0..π) entre hacia dónde mira `u` y la dirección hacia (x, y). */
function angleFrom(u: Unit, x: number, y: number) {
  let d = Math.atan2(y - u.y, x - u.x) - u.facing;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}
const deg = (r: number) => r * 180 / Math.PI;

/** Pilas de Goo sobre un enemigo. */
function goo(a: AbilityInst, e: Unit, n: number) {
  const u = a.owner as Unit;
  const cur = e.findMod('viscous_nasal_goo', u);
  const stacks = Math.min(val(a, 'stack_limit'), (cur?.stacks ?? 0) + n);
  const m = debuff(u, e, a, {
    name: 'viscous_nasal_goo', duration: val(a, 'goo_duration'), stacks, fx: 'slow',
    props: (mm) => ({
      armor: -(val(a, 'base_armor') + val(a, 'armor_per_stack') * mm.stacks),
      msSlow: (val(a, 'base_move_slow') + val(a, 'move_slow_per_stack') * mm.stacks) / 100,
    }),
  });
  if (m) { m.stacks = stacks; m.remaining = val(a, 'goo_duration'); e.refreshStats(); }
}

defineAbility({
  key: 'bristleback_viscous_nasal_goo', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'goo', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'goo_speed'), dodgeable: true,
      onHit() { goo(a, e, 1); return true; },
    });
  },
});

/** Quill Spray desde (x, y); `cone` limita a un cono [dirección, semiángulo]. */
function spray(a: AbilityInst, x: number, y: number, cone?: [number, number]) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  u.w.emit({ n: 'quill_spray', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r, { immune: true })) {
    if (cone) {
      let d = Math.atan2(e.y - y, e.x - x) - cone[0];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > cone[1]) continue;
    }
    u.w.after(Math.hypot(e.x - x, e.y - y) / val(a, 'projectile_speed'), () => {
      if (!e.alive) return;
      const st = e.findMod('quill_spray_stack', u);
      const n = st?.stacks ?? 0;
      damage(u, e, Math.min(val(a, 'max_damage'), dmg(a, 'quill_base_damage') + val(a, 'quill_stack_damage') * n), 'physical', a);
      if (!e.alive) return;
      const m = st ?? e.addMod({
        name: 'quill_spray_stack', duration: val(a, 'quill_stack_duration'), debuff: true, purgable: false, stacks: 0, interval: 0.25,
        onInterval(mm) { pruneTimedStack(mm, e.w.time); },
      }, u, a);
      addTimedStack(m, e.w.time, val(a, 'quill_stack_duration'));
    });
  }
}

defineAbility({
  key: 'bristleback_quill_spray', target: 'none', ai: { role: 'aoe', selfRadius: 650 },
  onSpellStart(a) { const u = a.owner as Unit; spray(a, u.x, u.y); },
});

// Pasiva; con Scepter se puede activar (ráfaga de Quill Sprays hacia atrás).
defineAbility({
  key: 'bristleback_bristleback', target: 'point', ai: { role: 'aoe' },
  castRange: () => 700,
  charges: (a) => [1, hasScepter(a.owner as Unit) ? val(a, 'activation_cooldown') : 1e9],
  passive: (a) => {
    const u = a.owner as Unit;
    if (!hasScepter(u)) { lockSub(a); a.data.locked = true; } else if (a.data.locked) { unlockSub(a); a.data.locked = false; }
    return {
      name: 'bristleback', data: { acc: 0 },
      onIncomingDamage(m, ev) {
        const s = ev.source as Unit | null;
        if (!s || s === u || ev.amount <= 0 || ev.hpRemoval || u.has(ST.broken)) return;
        const ang = deg(Math.PI - angleFrom(u, s.x, s.y));
        let red = 0;
        if (ang <= val(a, 'back_angle')) red = val(a, 'back_damage_reduction');
        else if (ang <= val(a, 'side_angle')) red = val(a, 'side_damage_reduction');
        if (!red) return;
        ev.amount *= 1 - red / 100;
        if (ang > val(a, 'back_angle')) return;
        // Recibir suficiente daño por la espalda suelta un Quill Spray.
        m.data.acc += ev.amount;
        const qs = find(u, 'bristleback_quill_spray');
        const thr = val(a, 'quill_release_threshold');
        if (m.data.acc >= thr && qs && qs.level > 0 && u.w.time >= (m.data.next ?? 0)) {
          m.data.acc -= thr;
          m.data.next = u.w.time + val(a, 'quill_release_interval');
          u.w.after(0, () => { if (u.alive) spray(qs, u.x, u.y); });
        }
      },
    };
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const qs = find(u, 'bristleback_quill_spray');
    const cost = val(a, 'activation_manacost') * (1 - u.s.manaReduce);
    if (!qs || qs.level <= 0 || u.mana < cost) { a.charges = 1; a.chargeCd = 0; return; }
    u.mana -= cost;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dir = Math.atan2(dy, dx);
    // Da la espalda al objetivo y escupe púas hacia él.
    u.facing = dir + Math.PI;
    const n = val(a, 'activation_num_quill_sprays');
    const every = val(a, 'activation_spray_interval');
    const delay = val(a, 'activation_delay');
    u.addMod({
      name: 'bristleback_active', duration: delay + every * (n - 1) + 0.05, states: ST.disarmed, fx: 'quill_spray',
      props: { msPct: val(a, 'activation_movement_speed_pct') / 100 },
      onTick() { u.facing = dir + Math.PI; },
    }, u, a);
    for (let i = 0; i < n; i++) {
      u.w.after(delay + i * every, () => { if (u.alive) spray(qs, u.x, u.y, [dir, val(a, 'activation_angle') * Math.PI / 180]); });
    }
  },
});

defineAbility({
  key: 'bristleback_hairball', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'hairball', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'projectile_speed'),
      left: Math.max(1, Math.min(dist(u, t), val(a, 'abilitycastrange') + u.s.castRange)), width: 0,
      onHit: () => false,
      onEnd(p) {
        const g = find(u, 'bristleback_viscous_nasal_goo');
        const qs = find(u, 'bristleback_quill_spray');
        if (g && g.level > 0) for (const e of u.w.enemiesIn(u.team, p.x, p.y, val(a, 'radius'))) goo(g, e, val(a, 'goo_stacks'));
        if (qs && qs.level > 0) for (let i = 0; i < val(a, 'quill_stacks'); i++) spray(qs, p.x, p.y);
      },
    });
  },
});

defineAbility({
  key: 'bristleback_warpath', target: 'passive', ult: true,
  passive: (a) => ({
    name: 'warpath', stacks: 0, interval: 0.25,
    props: (m) => ({ damage: m.stacks * val(a, 'damage_per_stack'), msPct: m.stacks * val(a, 'move_speed_per_stack') / 100, attackSpeed: m.stacks * val(a, 'aspd_per_stack') }),
    onAbilityExecuted(m, ab) {
      if (isItem(ab)) return;
      const u = m.owner as Unit;
      addTimedStack(m, u.w.time, val(a, 'stack_duration'), val(a, 'max_stacks'));
      u.refreshStats();
    },
    onInterval(m) {
      const list: number[] = m.data.exp ?? [];
      const now = (m.owner as Unit).w.time;
      if (!list.length || list[0] > now) return;
      while (list.length && list[0] <= now) list.shift();
      m.stacks = list.length;
      (m.owner as Unit).refreshStats();
    },
  }),
});

defineAbility({
  key: 'bristleback_prickly', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'prickly',
    // Más daño contra héroes enemigos que están a su espalda.
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.isHeroLike && deg(Math.PI - angleFrom(u, t.x, t.y)) <= val(a, 'angle')) ev.damage *= 1 + val(a, 'amp_pct') / 100;
    },
    onDealDamage(_m, ev) {
      const u = ev.source as Unit, t = ev.target as Unit;
      if (ev.isAttack || !ev.ability || ev.data?.prickly || !t.isHeroLike || t.team === u.team || ev.amount <= 0) return;
      if (deg(Math.PI - angleFrom(u, t.x, t.y)) > val(a, 'angle')) return;
      damage(u, t, ev.amount * val(a, 'amp_pct') / 100, ev.type, a, { noProc: true, hpRemoval: true, data: { prickly: true } });
    },
  }),
});

defineHero('bristleback', ['bristleback_viscous_nasal_goo', 'bristleback_quill_spray', 'bristleback_bristleback', 'bristleback_hairball', 'bristleback_warpath', 'bristleback_prickly'], {
  build: ['bracer', 'arcane_boots', 'vanguard', 'blade_mail', 'black_king_bar', 'shivas_guard', 'heart'],
});
