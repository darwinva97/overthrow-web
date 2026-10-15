import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, root, stun } from './util';
import { fear } from './lib/a2';

/** Una zarza: el primer enemigo que la pisa queda enraizado y recibe daño; luego desaparece. */
function bramble(a: AbilityInst, x: number, y: number, duration: number) {
  const u = a.owner as Unit;
  const bm = u.abilities.find((k) => k.key === 'dark_willow_bramble_maze' && k.level > 0) ?? a;
  const latch = val(bm, 'latch_duration');
  u.w.emit({ n: 'bramble', x, y, r: val(bm, 'latch_range'), d: duration, t: u.team });
  const z = u.w.addZone({
    fx: 'bramble', x, y, r: val(bm, 'latch_range'), team: u.team, interval: 0.1, duration,
    onInterval(zz) {
      const e = u.w.enemiesIn(u.team, zz.x, zz.y, val(bm, 'latch_range'))[0];
      if (!e) return;
      zz.until = u.w.time;
      const m = root(u, e, latch, bm, 'bramble_maze');
      if (!m) return;
      m.interval = 0.5;
      m.onInterval = (mm) => { damage(u, mm.owner as Unit, val(bm, 'damage_per_tick') * bm.upg.dmg, 'magical', bm, { noProc: true }); };
    },
  });
  return z;
}

defineAbility({
  key: 'dark_willow_bramble_maze', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'placement_range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const R = val(a, 'placement_range');
    const n = val(a, 'placement_count');
    // Laberinto: anillo interior en diagonal y exterior en cruz.
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const outer = i % 2 === 0;
      const ang = (i / n) * Math.PI * 2;
      const r = outer ? R * 0.8 : R * 0.4;
      pts.push([t.x + Math.cos(ang) * r, t.y + Math.sin(ang) * r]);
    }
    const start = val(a, 'initial_creation_delay');
    pts.forEach(([x, y], i) => {
      u.w.after(start + i * val(a, 'latch_creation_interval'), () => bramble(a, x, y, val(a, 'placement_duration')));
    });
  },
});

defineAbility({
  key: 'dark_willow_shadow_realm', target: 'none', ai: { role: 'nuke', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.disjoint(u);
    const start = u.w.time;
    const maxDmg = val(a, 'max_damage_duration');
    u.addMod({
      name: 'shadow_realm', duration: dur(a, 'duration'), fx: 'shadow_realm',
      states: ST.untargetable | ST.noCollision,
      props: { attackRange: val(a, 'attack_range_bonus') },
      onAttackStart(m, ev) {
        if (ev.fake) return;
        const f = Math.min(1, (u.w.time - start) / maxDmg);
        // El daño mágico viaja con el ataque aunque Shadow Realm termine antes del impacto.
        u.addMod({
          name: 'shadow_realm_shot', duration: 3, data: { multi: true, target: ev.target.id, amount: dmg(a, 'damage') * f },
          onAttackLanded(sm, lev) {
            if (lev.target.id !== sm.data.target || sm.data.done) return;
            sm.data.done = true;
            damage(u, lev.target as Unit, sm.data.amount, 'magical', a);
            sm.remaining = 0.001;
          },
        }, u, a);
        // Sin Scepter, el ataque termina Shadow Realm.
        if (!hasScepter(u)) m.data.ending = true;
      },
      onTick(m) {
        if (m.data.ending) m.remaining = Math.min(m.remaining, 0.001);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'dark_willow_cursed_crown', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const delay = val(a, 'delay') - val(a, 'shard_delay_reduction');
    debuff(u, e, a, {
      name: 'cursed_crown', duration: delay, fx: 'cursed_crown',
      onDestroy(m) {
        const v = m.owner as Unit;
        const done = m.remaining <= 0.0001 && v.alive;
        if (done) {
          const r = val(a, 'stun_radius');
          v.w.emit({ n: 'cursed_crown', x: v.x, y: v.y, r, t: u.team });
          for (const x of v.w.enemiesIn(u.team, v.x, v.y, r)) stun(u, x, dur(a, 'stun_duration'), a);
        }
        // Shard: zarzas alrededor, también si se disipa.
        if (hasShard(u) && !a.temp) {
          const n = val(a, 'shard_bramble_amount');
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2;
            const bm = u.abilities.find((k) => k.key === 'dark_willow_bramble_maze' && k.level > 0);
            bramble(a, v.x + Math.cos(ang) * val(a, 'shard_spawn_radius'), v.y + Math.sin(ang) * val(a, 'shard_spawn_radius'),
              bm ? val(bm, 'extra_brambles_placement_duration') : 4);
          }
        }
      },
    });
  },
});

defineAbility({
  key: 'dark_willow_bedlam', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 400 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (u.findMod('terrorize_active')) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    const period = val(a, 'roaming_seconds_per_rotation');
    const start = u.w.time;
    u.addMod({
      name: 'bedlam', duration: val(a, 'roaming_duration'), fx: 'bedlam', interval: val(a, 'attack_interval'),
      onInterval() {
        if (!u.alive) return;
        const ang = ((u.w.time - start) / period) * Math.PI * 2;
        const wx = u.x + Math.cos(ang) * val(a, 'roaming_radius'), wy = u.y + Math.sin(ang) * val(a, 'roaming_radius');
        const targets = u.w.enemiesIn(u.team, wx, wy, val(a, 'attack_radius'))
          .sort((p, q) => Math.hypot(p.x - wx, p.y - wy) - Math.hypot(q.x - wx, q.y - wy))
          .slice(0, val(a, 'target_count'));
        for (const e of targets) {
          u.w.addProjectile({
            kind: 'track', fx: 'bedlam', source: u, target: e, x: wx, y: wy, speed: val(a, 'travel_speed'),
            onHit() { damage(u, e, dmg(a, 'attack_damage'), 'magical', a); return true; },
          });
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'dark_willow_pixie_dust', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'pixie_dust', interval: 0.25,
    props: (m) => {
      const u = m.owner as Unit;
      const out = (u.s?.states ?? 0) & (ST.untargetable | ST.invulnerable);
      return out
        ? { hpRegenAmp: val(a, 'hp_regen_amp_out_of_world') / 100, manaRegenAmp: val(a, 'mana_regen_amp_out_of_world') / 100 }
        : { hpRegenAmp: val(a, 'hp_regen_amp') / 100, manaRegenAmp: val(a, 'mana_regen_amp') / 100 };
    },
    onInterval(m) {
      const u = m.owner as Unit;
      const out = u.has(ST.untargetable | ST.invulnerable);
      if (out !== !!m.data.out) { m.data.out = out; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'dark_willow_terrorize', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'destination_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (u.findMod('bedlam')) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const travel = d / val(a, 'destination_travel_speed');
    const r = val(a, 'destination_radius');
    u.addMod({ name: 'terrorize_active', duration: travel + d / val(a, 'return_travel_speed') }, u, a);
    u.w.emit({ n: 'terrorize', x: u.x, y: u.y, x2: t.x, y2: t.y, r, d: travel, t: u.team });
    u.w.after(travel, () => {
      u.w.emit({ n: 'terrorize_impact', x: t.x, y: t.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        const imp = val(a, 'impact_damage');
        if (imp > 0) damage(u, e, imp, 'magical', a);
        if (e.alive) fear(u, e, dur(a, 'destination_status_duration'), a, 'terrorize');
      }
    });
  },
});

defineHero('dark_willow', ['dark_willow_bramble_maze', 'dark_willow_shadow_realm', 'dark_willow_cursed_crown', 'dark_willow_bedlam', 'dark_willow_pixie_dust', 'dark_willow_terrorize'], {
  build: ['null_talisman', 'arcane_boots', 'blink', 'aether_lens', 'force_staff', 'black_king_bar', 'ultimate_scepter', 'sheepstick'],
  upgrades: [
    { slot: 0, key: 'latch_duration', amount: 0.25, max: 4, label: 'Bramble Maze: +0,25 s de raíz' },
    { slot: 1, key: 'damage', amount: 50, max: 5, label: 'Shadow Realm: +50 daño' },
    { slot: 2, key: 'stun_duration', amount: 0.2, max: 4, label: 'Cursed Crown: +0,2 s de aturdimiento' },
    { slot: 3, key: 'attack_damage', amount: 15, max: 5, label: 'Bedlam: +15 daño por ataque' },
    { slot: 5, key: 'destination_radius', amount: 40, max: 4, label: 'Terrorize: +40 radio' },
  ],
});
