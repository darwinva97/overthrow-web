import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { expire, gate, helper, isUnitLike } from './lib/a8';
import { dash, debuff, slow, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'techies_sticky_bomb', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'explosion_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const explode = (x: number, y: number) => {
      const r = val(a, 'explosion_radius');
      w.emit({ n: 'sticky_bomb', x, y, r, t: u.team });
      for (const e of w.enemiesIn(u.team, x, y, r)) {
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        slow(u, e, a, 'sticky_bomb_slow', val(a, 'secondary_slow_duration'), val(a, 'secondary_slow') / 100);
      }
    };
    w.emit({ n: 'lob', x: u.x, y: u.y, x2: t.x, y2: t.y, d: val(a, 'duration'), u: u.id });
    w.after(val(a, 'duration'), () => {
      // Se pega al héroe enemigo más cercano del radio de aterrizaje.
      const v = w.enemiesIn(u.team, t.x, t.y, val(a, 'radius'), { heroes: true })
        .sort((p, q) => Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))[0];
      if (!v) { w.after(val(a, 'countdown'), () => explode(t.x, t.y)); return; }
      const m = debuff(u, v, a, {
        name: 'sticky_bomb', duration: val(a, 'countdown'), purgable: false, fx: 'sticky_bomb',
        props: { msSlow: val(a, 'slow') / 100 },
        onDestroy(mm) { const o = mm.owner as Unit; explode(o.x, o.y); },
      });
      if (!m) w.after(val(a, 'countdown'), () => explode(v.x, v.y));
    });
  },
});

defineAbility({
  key: 'techies_reactive_tazer', target: 'unit', team: 'any', allowSelf: true, reflectable: false, ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Solo aliados: si se apunta a un enemigo (bots), se lo pone Techies.
    const tgt = t.unit && t.unit.team === u.team ? (t.unit as Unit) : u;
    const explode = (o: Unit) => {
      const r = val(a, 'explosion_radius');
      u.w.emit({ n: 'reactive_tazer', x: o.x, y: o.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, o.x, o.y, r)) {
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        debuff(u, e, a, { name: 'tazer_disarm', duration: val(a, 'disarm_duration'), states: ST.disarmed, fx: 'disarm' });
      }
    };
    a.data.mod = tgt.addMod({
      name: 'reactive_tazer', duration: dur(a, 'duration'), fx: 'reactive_tazer',
      props: { msPct: val(a, 'bonus_ms') / 100 },
      onAttacked(_m, ev) {
        const at = ev.attacker as Unit;
        if (at.team === u.team || ev.fake) return;
        if (debuff(u, at, a, { name: 'tazer_disarm', duration: val(a, 'disarm_duration'), states: ST.disarmed, fx: 'disarm' })) at.purge(false, true);
      },
      onDestroy(m) { a.data.mod = null; explode(m.owner as Unit); },
    }, u, a);
  },
});

defineAbility({
  key: 'techies_reactive_tazer_stop', target: 'none', levelWith: 1, ai: { role: 'aoe', selfRadius: 350 },
  hidden: (a) => !ability(a.owner as Unit, 'techies_reactive_tazer')?.data.mod,
  passive: (a) => ({ name: 'tazer_stop_gate', onTick() { gate(a, !!ability(a.owner as Unit, 'techies_reactive_tazer')?.data.mod); } }),
  onSpellStart(a) {
    const tz = ability(a.owner as Unit, 'techies_reactive_tazer');
    const m = tz?.data.mod;
    if (m?.owner) (m.owner as Unit).removeMod(m);
  },
});

defineAbility({
  key: 'techies_suicide', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const d = Math.max(1, Math.hypot(t.x - u.x, t.y - u.y));
    u.w.disjoint(u);
    dash(u, t.x, t.y, d / val(a, 'duration'), a, {
      name: 'blast_off', states: ST.flying,
      onArrive() {
        const r = val(a, 'radius');
        u.w.emit({ n: 'blast_off', x: u.x, y: u.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          stun(u, e, dur(a, 'stun_duration'), a);
        }
        damage(u, u, u.hp * val(a, 'hp_cost') / 100, 'pure', a, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
      },
    });
  },
});

/** Barril de M.A.D.: explota en área según el maná máximo de Techies. */
function madExplode(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  u.w.emit({ n: 'mad', x, y, r, t: u.team });
  const amount = (val(a, 'base_damage') + u.s.maxMana * val(a, 'max_mana_pct_as_damage') / 100) * a.upg.dmg;
  for (const e of u.w.enemiesIn(u.team, x, y, r)) damage(u, e, amount, 'magical', a);
}

defineAbility({
  key: 'techies_mutually_assured_destruction', target: 'point', innate: true, noIllusion: true, ai: { role: 'aoe' },
  hidden: (a) => !hasShard(a.owner as Unit),
  aoe: (a) => val(a, 'radius'),
  passive: (a) => ({
    name: 'mad',
    props: () => ({ manaRegen: (a.owner as Unit).s.maxMana * val(a, 'bonus_mana_as_mana_regen') / 100 }),
    onTick() { gate(a, hasShard(a.owner as Unit)); },
    onDeath(m) {
      const u = m.owner as Unit;
      const x = u.x, y = u.y;
      u.w.emit({ n: 'mad_barrel', x, y, d: val(a, 'explosion_delay'), t: u.team });
      u.w.after(val(a, 'explosion_delay'), () => madExplode(a, x, y));
    },
  }),
  // Con Shard: planta un barril que se detona con Focused Detonate.
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (!hasShard(u)) return;
    const old = a.data.barrel as Unit | undefined;
    if (old?.alive) expire(old);
    const b = helper(u, 'techies_innate_mine', t.x, t.y, Infinity, ST.noCollision);
    b.addMod({ name: 'mad_barrel', persistent: true, fx: 'mad_barrel', onIncomingDamage(_m, ev) { if (!ev.isAttack) ev.amount = 0; } });
    a.data.barrel = b;
  },
});

defineAbility({
  key: 'techies_focused_detonate', target: 'none', requires: 'shard', ai: { role: 'aoe', selfRadius: 900 },
  hidden: (a) => !mad(a)?.data.barrel?.alive,
  passive: (a) => ({ name: 'focused_detonate_gate', onTick() { gate(a, !!mad(a)?.data.barrel?.alive); } }),
  onSpellStart(a) {
    const m = mad(a);
    const b = m?.data.barrel as Unit | undefined;
    if (!m || !b?.alive) return;
    madExplode(m, b.x, b.y);
    expire(b);
    m.data.barrel = null;
  },
});
function mad(a: AbilityInst) { return ability(a.owner as Unit, 'techies_mutually_assured_destruction'); }

/** Cartel del campo de minas activo (con Scepter). */
function signOf(u: Unit): Unit | null {
  const s = ability(u, 'techies_minefield_sign')?.data.sign as Unit | undefined;
  return s?.alive ? s : null;
}

defineAbility({
  key: 'techies_minefield_sign', target: 'point', castBeyond: true, ai: { role: 'summon' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const old = signOf(u);
    if (old) expire(old);
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const k = d > val(a, 'abilitycastrange') + 100 ? (val(a, 'abilitycastrange') + 100) / d : 1;
    const s = helper(u, 'techies_minefield_sign', u.x + (t.x - u.x) * k, u.y + (t.y - u.y) * k, val(a, 'lifetime'), ST.noCollision);
    a.data.sign = s;
    s.addMod({
      name: 'minefield_sign', persistent: true, fx: 'minefield_sign', data: { active: 0 },
      onTick(m) {
        if (m.data.active) return;
        if (!w.enemiesIn(u.team, s.x, s.y, val(a, 'trigger_radius'), { heroes: true }).length) return;
        m.data.active = 1;
        const R = val(a, 'aura_radius');
        const last = new Map<number, [number, number, number]>();
        w.emit({ n: 'minefield', x: s.x, y: s.y, r: R, d: val(a, 'minefield_duration'), t: u.team });
        // Cada `scepter_move_amt` de distancia recorrida dentro del área, daño.
        w.addZone({
          fx: 'minefield', x: s.x, y: s.y, r: R, team: u.team, interval: 0.1, duration: val(a, 'minefield_duration'),
          onInterval(z) {
            for (const e of w.enemiesIn(u.team, z.x, z.y, z.r, { heroes: true })) {
              const p = last.get(e.id);
              let acc = p ? p[2] + Math.hypot(e.x - p[0], e.y - p[1]) : 0;
              while (acc >= val(a, 'scepter_move_amt')) {
                acc -= val(a, 'scepter_move_amt');
                damage(u, e, val(a, 'scepter_move_damage'), 'magical', a);
              }
              last.set(e.id, [e.x, e.y, acc]);
            }
          },
        });
        s.expireAt = w.time + val(a, 'minefield_duration');
      },
    });
  },
});

defineAbility({
  key: 'techies_land_mines', target: 'point', ult: true, ai: { role: 'aoe' },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  castRange: (a) => val(a, 'abilitycastrange') + val(a, 'cast_range_scepter_bonus'),
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const mine = helper(u, 'techies_land_mine', t.x, t.y, Infinity, ST.noCollision);
    const born = w.time;
    const signed = () => {
      const s = signOf(u);
      return !!s && hasScepter(u) && Math.hypot(s.x - mine.x, s.y - mine.y) <= 1000;
    };
    mine.addMod({
      name: 'land_mine', persistent: true, fx: 'land_mine', states: ST.hidden, data: { inside: 0 },
      onIncomingDamage(_m, ev) { if (!ev.isAttack || signed()) ev.amount = 0; },
      onTick(m, dt) {
        const R = val(a, 'radius');
        const near = w.time - born >= val(a, 'proximity_threshold') &&
          w.unitsIn(mine.x, mine.y, R, (e) => e.team !== u.team && isUnitLike(e) && w.targetable(e) && !e.has(ST.invulnerable)).length > 0;
        // Invisible incluso para True Sight; solo se ve con un enemigo dentro de su radio.
        const st = near ? ST.invisible | ST.revealed : ST.hidden;
        if (m.states !== st) { m.states = st; mine.refreshStats(); }
        m.data.inside = near ? m.data.inside + dt : 0;
        if (m.data.inside < val(a, 'activation_delay')) return;
        const amp = signed() ? 1 + 0.15 : 1;
        w.emit({ n: 'land_mine_blast', x: mine.x, y: mine.y, r: R, t: u.team });
        for (const e of w.enemiesIn(u.team, mine.x, mine.y, R)) {
          const d = Math.hypot(e.x - mine.x, e.y - mine.y);
          const minD = val(a, 'min_distance');
          const k = d <= minD ? 1 : 1 - (1 - val(a, 'outer_damage') / 100) * Math.min(1, (d - minD) / Math.max(1, R - minD));
          damage(u, e, dmg(a, 'damage') * k * amp, 'magical', a);
          debuff(u, e, a, { name: 'land_mine_burn', duration: val(a, 'burn_duration'), props: { magicResist: -val(a, 'mres_reduction') / 100 } });
        }
        expire(mine);
      },
    });
  },
});

defineHero('techies', ['techies_sticky_bomb', 'techies_reactive_tazer', 'techies_suicide', 'techies_mutually_assured_destruction',
  'techies_minefield_sign', 'techies_land_mines', 'techies_reactive_tazer_stop', 'techies_focused_detonate'], {
  build: ['null_talisman', 'arcane_boots', 'soul_ring', 'aether_lens', 'kaya', 'ultimate_scepter', 'octarine_core', 'black_king_bar'],
});
