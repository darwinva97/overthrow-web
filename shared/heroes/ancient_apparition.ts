import { defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, slow, stun } from './util';
import { addTimedStack, dist, LOCKED, lockSub, pruneTimedStack, unlockSub } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

function coldFeet(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  const ox = e.x, oy = e.y;
  debuff(u, e, a, {
    name: 'cold_feet', duration: dur(a, 'abilityduration'), interval: 1, fx: 'frostbite', data: { multi: false },
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage_per_second'), 'magical', a, { noProc: true }); },
    onTick(m) {
      const v = m.owner as Unit;
      if (Math.hypot(v.x - ox, v.y - oy) > val(a, 'break_distance')) { m.data.broken = true; m.remaining = 0.001; }
    },
    onDestroy(m) {
      const v = m.owner as Unit;
      if (!m.data.broken && v.alive && m.remaining <= 0.05) stun(u, v, val(a, 'stun_duration'), a);
    },
  });
}

defineAbility({
  key: 'ancient_apparition_cold_feet', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const r = val(a, 'area_of_effect');
    const list = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r) : [e];
    if (!list.includes(e)) list.push(e);
    for (const v of list) coldFeet(a, v);
  },
});

defineAbility({
  key: 'ancient_apparition_ice_vortex', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const d = dur(a, 'vortex_duration');
    u.w.addVision(u.team, t.x, t.y, val(a, 'vision_aoe'), d);
    u.w.addZone({
      fx: 'ice_vortex', x: t.x, y: t.y, r, team: u.team, interval: 0.1, duration: d,
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
          debuff(u, e, a, {
            name: 'ice_vortex', duration: 0.2, fx: 'slow',
            props: { msSlow: Math.abs(val(a, 'movement_speed_pct')) / 100, magicResist: val(a, 'spell_resist_pct') / 100 },
          });
          damage(u, e, dmg(a, 'damage_per_second') * 0.1, 'magical', a, { noProc: true });
          // Arrastra hacia el centro.
          const dd = dist(e, z);
          if (dd > 10 && !e.has(ST.magicImmune)) {
            const step = Math.min(dd, val(a, 'drag_speed') * 0.1);
            e.w.forceMove(e, e.x + (z.x - e.x) / dd * step, e.y + (z.y - e.y) / dd * step);
          }
        }
      },
    });
  },
});

// Orbe autolanzable: con el autocast (o si es bot) los ataques gastan maná y lo aplican.
defineAbility({
  key: 'ancient_apparition_chilling_touch', target: 'toggle',
  onToggle(a) { (a.owner as Unit).refreshStats(); },
  passive: (a) => ({
    name: 'chilling_touch',
    props: () => ((a.toggled || (a.owner as Unit).isBot) ? { attackRange: val(a, 'attack_range_bonus') } : {}),
    onTick(m) { const u = m.owner as Unit; if (u.isBot && !m.data.botOn) { m.data.botOn = true; u.refreshStats(); } },
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      m.data.proc = 0;
      if (!(a.toggled || u.isBot) || t.team === u.team || u.has(ST.silenced) || (a.data.readyAt ?? 0) > u.w.time) return;
      const mc = manaCostOf(a);
      if (u.mana < mc || u.kind === 'illusion') return;
      u.mana -= mc;
      a.data.readyAt = u.w.time + val(a, '_cd') * (1 - u.s.cdr);
      m.data.proc = t.id;
    },
    onAttackLanded(m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (m.data.proc !== t.id || ev.missed) return;
      m.data.proc = 0;
      damage(u, t, dmg(a, 'damage'), 'magical', a);
      slow(u, t, a, 'chilling_touch', val(a, 'slow_duration'), val(a, 'slow') / 100);
    },
  }),
});

defineAbility({
  key: 'ancient_apparition_bone_chill', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'bone_chill_passive',
    onDealDamage(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (ev.type !== 'magical' || !ev.ability || ev.isAttack || t.team === u.team || !t.alive || ev.amount <= 0) return;
      const d = val(a, 'str_reduction_duration');
      const mod = debuff(u, t, a, {
        name: 'bone_chill', duration: d, stacks: 0, fx: 'slow', interval: 0.1,
        props: (mm) => ({ msSlow: mm.stacks * val(a, 'movement_slow_pct') / 100, str: t.kind === 'hero' ? -mm.stacks * val(a, 'str_reduction') : 0 }),
        onInterval(mm) { if (pruneTimedStack(mm, t.w.time)) t.refreshStats(); },
      });
      if (mod) { addTimedStack(mod, t.w.time, d, 60); t.refreshStats(); }
    },
  }),
});

/** Frostbite de Ice Blast: sin curación, daño en el tiempo y muerte por debajo del umbral. */
function frostbite(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  const m = debuff(u, e, a, {
    name: 'ice_blast', duration: dur(a, 'frostbite_duration'), fx: 'frostbite', interval: 1,
    props: { hpRegenAmp: -1 },
    onInterval(mm) { damage(u, mm.owner as Unit, dmg(a, 'damage_per_second'), 'magical', a, { noProc: true }); },
    onTakeDamage(mm) {
      const v = mm.owner as Unit;
      if (v.alive && v.hp / v.s.maxHp * 100 < val(a, 'kill_pct')) {
        u.w.emit({ n: 'frost_explosion', x: v.x, y: v.y, r: 150, t: u.team });
        damage(u, v, v.hp + 1, 'pure', a, { hpRemoval: true });
      }
    },
  });
  // Shard: congela como Cold Feet durante la mitad de su aturdimiento.
  const pct = val(a, 'cold_feet_stun_duration_pct');
  const cf = find(u, 'ancient_apparition_cold_feet');
  if (m && pct > 0 && cf && cf.level > 0 && !e.findMod('ice_blast_shard_freeze')) {
    stun(u, e, val(cf, 'stun_duration') * pct / 100, a);
    e.addMod({ name: 'ice_blast_shard_freeze', duration: val(a, 'frostbite_duration') }, u, a);
  }
}

defineAbility({
  key: 'ancient_apparition_ice_blast', target: 'point', ult: true, castBeyond: true, ai: { role: 'nuke', hpBelow: 0.7 },
  castRange: () => 1e5,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const rel = find(u, 'ancient_apparition_ice_blast_release');
    const speed = val(a, 'speed');
    const want = dist(u, t);
    const tracer = u.w.addProjectile({
      kind: 'linear', fx: 'ice_blast_tracer', source: u, x: u.x, y: u.y, dx, dy, speed, left: 12000, width: 0,
      onHit: () => false,
      onThink(p) {
        // Los bots lo sueltan al llegar al punto elegido.
        if (u.isBot && p.travelled >= want && rel && !u.w.castCheck(u, rel)) u.w.issueOrder(u, { type: 'cast', slot: rel.slot });
      },
      onEnd(p) { release(a, p.x, p.y, p.travelled / speed); },
    });
    a.data.tracer = tracer;
    unlockSub(rel);
  },
});

/** Lanza la bola de hielo desde el héroe hasta (x, y) y explota allí. */
function release(a: AbilityInst, x: number, y: number, flight: number) {
  const u = a.owner as Unit;
  a.data.tracer = null;
  lockSub(find(u, 'ancient_apparition_ice_blast_release'));
  u.w.addVision(u.team, x, y, val(a, 'target_sight_radius'), 4);
  const r = Math.min(val(a, 'radius_max'), val(a, 'radius_min') + val(a, 'radius_grow') * flight);
  const [dx, dy] = castDir(u, x, y);
  const len = dist(u, { x, y });
  const hit = new Set<number>();
  u.w.addProjectile({
    kind: 'linear', fx: 'ice_blast', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'), left: len, width: val(a, 'path_radius'),
    onHit(_p, e) {
      if (e.team === u.team || hit.has(e.id)) return false;
      hit.add(e.id);
      frostbite(a, e as Unit);
      return false;
    },
    onEnd() {
      u.w.emit({ n: 'frost_explosion', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r, { immune: true })) {
        frostbite(a, e);
        damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
      }
    },
  });
}

defineAbility({
  key: 'ancient_apparition_ice_blast_release', target: 'none', levelWith: 4, sub: true,
  hidden: (a) => !find(a.owner as Unit, 'ancient_apparition_ice_blast')?.data.tracer,
  charges: () => LOCKED,
  passive: (a) => { if (!find(a.owner as Unit, 'ancient_apparition_ice_blast')?.data.tracer) lockSub(a); return null; },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const ib = find(u, 'ancient_apparition_ice_blast');
    const p = ib?.data.tracer;
    if (!ib || !p) return;
    p.dead = true;
    release(ib, p.x, p.y, p.travelled / val(ib, 'speed'));
  },
});

defineHero('ancient_apparition', ['ancient_apparition_cold_feet', 'ancient_apparition_ice_vortex', 'ancient_apparition_chilling_touch', 'ancient_apparition_bone_chill', 'ancient_apparition_ice_blast', 'ancient_apparition_ice_blast_release'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'ultimate_scepter', 'sheepstick'],
});
