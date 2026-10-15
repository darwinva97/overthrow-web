import { defineAbility, defineHero, dmg, dur, hasScepter, manaCostOf, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dist, stationary } from './lib/a9';
import { canDebuff, debuff, stun } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Rebote de Paralyzing Cask. */
function cask(a: AbilityInst, from: { x: number; y: number }, e: Unit, left: number, n: number, prev: number) {
  const u = a.owner as Unit;
  u.w.addProjectile({
    kind: 'track', fx: 'paralyzing_cask', source: u, target: e, x: from.x, y: from.y, speed: val(a, 'speed'), dodgeable: true,
    onHit() {
      if (canDebuff(u, e, a)) {
        const base = dmg(a, 'base_damage') + val(a, 'bounce_bonus_damage') * n;
        damage(u, e, e.isHeroLike ? base : base * val(a, 'creep_damage_pct') / 100, 'magical', a);
        stun(u, e, e.isHeroLike ? dur(a, 'hero_duration') : dur(a, 'creep_duration'), a);
      }
      if (left <= 0) return true;
      // Puede volver a un objetivo anterior, pero no al mismo dos veces seguidas.
      const next = u.w.enemiesIn(u.team, e.x, e.y, val(a, 'bounce_range'))
        .filter((x) => x !== e && x.id !== prev && x.kind !== 'ward' && u.w.canSee(u.team, x))
        .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, e) - dist(q, e))[0]
        ?? u.w.enemiesIn(u.team, e.x, e.y, val(a, 'bounce_range')).find((x) => x !== e && x.kind !== 'ward');
      if (next) {
        const x = e.x, y = e.y, id = e.id;
        u.w.after(val(a, 'bounce_delay'), () => { if (next.alive) cask(a, { x, y }, next, left - 1, n + 1, id); });
      }
      return true;
    },
  });
}

defineAbility({
  key: 'witch_doctor_paralyzing_cask', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) { cask(a, a.owner as Unit, t.unit as Unit, val(a, 'bounces'), 0, 0); },
});

defineAbility({
  key: 'witch_doctor_voodoo_restoration', target: 'toggle', noIllusion: true, ai: { role: 'heal' },
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!on) { u.removeModsByName('voodoo_restoration'); return; }
    u.mana = Math.max(0, u.mana - manaCostOf(a));
    const iv = val(a, 'heal_interval');
    u.addMod({
      name: 'voodoo_restoration', fx: 'voodoo_restoration', interval: iv,
      onInterval(m) {
        const cost = val(a, 'mana_per_second') * iv * (1 - u.s.manaReduce);
        if (u.mana < cost || u.has(ST.silenced)) { a.toggled = false; u.removeMod(m); return; }
        u.mana -= cost;
        for (const al of u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'))) {
          if (!al.isHeroLike && al.kind !== 'creep' && al.kind !== 'summon') continue;
          heal(al, (dmg(a, 'heal') + al.s.maxHp * val(a, 'bonus_heal_percent') / 100) * iv, u, true);
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'witch_doctor_maledict', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const r = val(a, 'radius');
    const d = dur(a, 'abilityduration');
    const every = d / Math.max(1, val(a, 'ticks'));
    w.emit({ n: 'maledict', x: t.x, y: t.y, r, t: u.team });
    for (const e of w.enemiesIn(u.team, t.x, t.y, r)) {
      if (!e.isHeroLike && !e.playerId) continue;
      const start = e.hp;
      let acc = 0;
      debuff(u, e, a, {
        name: 'maledict', duration: d, interval: 1, fx: 'maledict', purgable: false,
        onInterval(m) {
          const v = m.owner as Unit;
          damage(u, v, dmg(a, 'abilitydamage'), 'magical', a, { noProc: true });
          acc += 1;
          if (acc + 1e-6 < every) return;
          acc -= every;
          // Estallido según la vida perdida desde que empezó la maldición.
          const lost = Math.max(0, start - v.hp);
          const burst = lost / val(a, 'bonus_damage_threshold') * dmg(a, 'bonus_damage');
          if (burst <= 0) return;
          w.emit({ n: 'maledict_burst', x: v.x, y: v.y, u: v.id });
          damage(u, v, burst, 'magical', a);
          if (val(a, 'spread_pct') > 0) {
            for (const o of w.enemiesIn(u.team, v.x, v.y, val(a, 'spread_radius'), { heroes: true })) {
              if (o !== v) damage(u, o, burst * val(a, 'spread_pct') / 100, 'magical', a);
            }
          }
        },
      });
    }
  },
});

/** Death Ward: ataca a héroes enemigos con daño puro; con Scepter rebota y roba vida. */
function deathWard(u: Unit, a: AbilityInst, x: number, y: number, duration: number, asMult: number) {
  const w = u.w;
  const ward = w.spawnSummon(u, 'witch_doctor_death_ward', x, y, duration, { abilities: [], kind: 'summon' });
  stationary(ward);
  const range = val(a, 'attack_range_tooltip');
  const scepter = hasScepter(u);
  const fire = (from: { x: number; y: number }, t: Unit, hit: Set<number>) => {
    hit.add(t.id);
    w.addProjectile({
      kind: 'track', fx: 'death_ward', source: ward, target: t, x: from.x, y: from.y, speed: ward.base.projSpeed, dodgeable: true,
      onHit() {
        // Precisión extra: la mitad de la evasión no cuenta.
        if (w.rng() < t.s.evasion * (1 - val(a, 'bonus_accuracy') / 100)) { w.emit({ n: 'miss', x: t.x, y: t.y, u: t.id }); }
        else {
          const dealt = damage(u, t, dmg(a, 'damage'), 'pure', a, { data: { deathWard: true } });
          if (scepter) heal(u, dealt * val(a, 'scepter_lifesteal') / 100, u, true);
        }
        if (scepter) {
          const next = w.enemiesIn(u.team, t.x, t.y, val(a, 'bounce_radius'), { immune: false })
            .filter((e) => !hit.has(e.id) && e.isHeroLike && w.canSee(u.team, e))
            .sort((p, q) => dist(p, t) - dist(q, t))[0];
          if (next) fire(t, next, hit);
        }
        return true;
      },
    });
  };
  ward.addMod({
    name: 'death_ward', persistent: true, fx: 'death_ward', states: ST.invulnerable | ST.disarmed,
    data: { acc: 0, target: 0 },
    onTick(m, dt) {
      if (!u.alive) { ward.expireAt = w.time; return; }
      m.data.acc += dt;
      const every = ward.base.bat / asMult;
      if (m.data.acc < every) return;
      let t = w.units.get(m.data.target);
      const ok = (e: Unit | undefined): e is Unit => !!e && e.alive && w.targetable(e) && e.team !== u.team && e.isHeroLike &&
        w.canSee(u.team, e) && dist(e, ward) <= range + e.radius && !e.has(ST.invulnerable);
      if (!ok(t)) {
        t = w.enemiesIn(u.team, ward.x, ward.y, range, { heroes: true, immune: false })
          .filter((e) => ok(e)).sort((p, q) => dist(p, ward) - dist(q, ward))[0];
      }
      if (!t) { m.data.acc = every; return; }
      m.data.acc -= every;
      m.data.target = t.id;
      ward.facing = Math.atan2(t.y - ward.y, t.x - ward.x);
      fire(ward, t, new Set());
    },
  }, u, a);
  return ward;
}

defineAbility({
  key: 'witch_doctor_voodoo_switcheroo', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const dw = ab(u, 'witch_doctor_death_ward') ?? a;
    const d = dur(a, 'duration');
    u.w.disjoint(u);
    u.order = null; u.atk.phase = 0;
    u.addMod({ name: 'voodoo_switcheroo', duration: d, states: ST.hidden | ST.invulnerable | ST.untargetable | ST.noCollision | ST.busy, fx: 'switcheroo' }, u, a);
    deathWard(u, dw, u.x, u.y, d, 1 - val(a, 'attack_speed_reduction') / 100);
  },
});

defineAbility({
  key: 'witch_doctor_gris_gris', target: 'passive', innate: true, noIllusion: true,
  // Sin pérdida de oro al morir en este modo: el valor del Gris-Gris se cobra directamente.
  passive: (a) => ({
    name: 'gris_gris', interval: val(a, 'gold_tick_interval_tooltip'),
    onInterval(m) { const u = m.owner as Unit; if (u.kind === 'hero' && u.alive) u.gold += 1; },
  }),
});

defineAbility({
  key: 'witch_doctor_death_ward', target: 'point', ult: true, ai: { role: 'nuke' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    a.data.ward = deathWard(u, a, t.x, t.y, val(a, 'abilitychanneltime') + 0.1, 1).id;
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    const ward = u.w.units.get(a.data.ward);
    if (ward && ward.alive) ward.expireAt = u.w.time;
  },
});

defineHero('witch_doctor', ['witch_doctor_paralyzing_cask', 'witch_doctor_voodoo_restoration', 'witch_doctor_maledict',
  'witch_doctor_voodoo_switcheroo', 'witch_doctor_gris_gris', 'witch_doctor_death_ward'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'black_king_bar', 'ultimate_scepter', 'aether_lens', 'refresher'],
});
