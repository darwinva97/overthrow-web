import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, manaCostOf, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst, ItemInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff } from './util';

defineAbility({
  key: 'pugna_nether_blast', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const delay = val(a, 'delay');
    u.w.emit({ n: 'nether_blast_warn', x: t.x, y: t.y, r, d: delay, t: u.team });
    u.w.after(delay, () => {
      u.w.emit({ n: 'nether_blast', x: t.x, y: t.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) damage(u, e, dmg(a, 'blast_damage'), 'magical', a);
    });
  },
});

defineAbility({
  key: 'pugna_decrepify', target: 'unit', team: 'any', allowSelf: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'abilityduration');
    if (e.team === u.team) {
      e.addMod({
        name: 'decrepify', duration: d, purgable: true, fx: 'decrepify', states: ST.ethereal | ST.disarmed,
        props: { healAmp: val(a, 'bonus_heal_amp_pct_allies') / 100, msPct: val(a, 'bonus_movement_speed_allies') / 100 },
      }, u, a);
      return;
    }
    // El motor ya multiplica por 1,4 el daño mágico a etéreos: se ajusta a la amplificación real.
    const amp = 1 + Math.abs(val(a, 'bonus_spell_damage_pct')) / 100;
    debuff(u, e, a, {
      name: 'decrepify', duration: d, fx: 'decrepify', states: ST.ethereal | ST.disarmed,
      props: { msSlow: Math.abs(val(a, 'bonus_movement_speed')) / 100, magicResist: 1 - amp / 1.4 },
    });
  },
});

/** Dispara el rayo de la Nether Ward a quien lanza cerca. */
function wardZap(ward: Unit, a: AbilityInst, caster: Unit, spell: AbilityInst | ItemInst) {
  const u = a.owner as Unit;
  if (!ward.alive || !caster.alive) return;
  const mana = isItem(spell) ? spell.def.mc : manaCostOf(spell);
  if (mana <= 0) return;
  u.w.emit({ n: 'nether_ward_zap', x: ward.x, y: ward.y, x2: caster.x, y2: caster.y, t: u.team });
  damage(ward, caster, dmg(a, 'base_damage') + mana * val(a, 'mana_multiplier'), 'magical', a);
}

defineAbility({
  key: 'pugna_nether_ward', target: 'point', ai: { role: 'summon' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    for (const w0 of u.w.list) if (w0.alive && w0.owner === u && w0.name === 'pugna_nether_ward') w0.expireAt = u.w.time;
    const ward = u.w.spawnSummon(u, 'pugna_nether_ward', t.x, t.y, dur(a, 'abilityduration'), {
      kind: 'ward', hp: val(a, 'attacks_to_destroy'), bounty: val(a, 'nether_ward_gold_bounty'),
    });
    ward.addMod({
      name: 'nether_ward', persistent: true, fx: 'nether_ward', states: ST.rooted | ST.disarmed,
      // Los héroes le quitan 1 golpe; el resto, un cuarto.
      onIncomingDamage(_m, ev) {
        if (!ev.isAttack) { ev.amount = 0; return; }
        ev.amount = (ev.source as Unit | null)?.isHeroLike ? 1 : 0.25;
      },
      aura: {
        radius: val(a, 'radius'), team: 'enemy', heroesOnly: true,
        apply: () => ({
          name: 'nether_ward_watch', debuff: true, purgable: false,
          onAbilityExecuted(m, spell) {
            const c = m.owner as Unit;
            if (c.kind === 'hero') wardZap(ward, a, c, spell);
          },
        }),
      },
    }, u, a);
  },
});

/**
 * Oblivion Savant: Pugna puede lanzar mientras canaliza. El motor corta la canalización con
 * cualquier orden de lanzamiento, así que se aparta la canalización un instante y se repone.
 */
defineAbility({
  key: 'pugna_oblivion_savant', target: 'passive', innate: true,
  passive: () => ({
    name: 'oblivion_savant',
    onOrder(_m, o) {
      const u = _m.owner as Unit;
      const c = u.cast;
      if (!c || c.phase !== 2 || (o.type !== 'cast' && o.type !== 'item')) return;
      const spell = o.type === 'cast' ? u.abilities[o.slot] : u.items[o.slot];
      if (!spell || spell === c.a) return;
      u.cast = null;
      const order = u.order;
      u.w.after(0, () => {
        // Se lanza al momento si está a su alcance; la canalización sigue.
        if (u.cast && u.cast.a === spell) u.cast = null;
        if (!u.alive || u.cast || !u.findMod('channeling')) return;
        const tu = o.target ? u.w.units.get(o.target) : undefined;
        const tx = tu ? tu.x : o.x ?? u.x, ty = tu ? tu.y : o.y ?? u.y;
        const range = isItem(spell) ? (spell.impl?.castRange?.(spell) ?? 0) + u.s.castRange : castRangeOf(spell);
        if (!u.w.castCheck(u, spell) && (range <= 0 || Math.hypot(tx - u.x, ty - u.y) <= range + 50)) {
          u.w.executeCast(u, spell, { unit: tu, x: tx, y: ty });
        }
        u.cast = c;
        u.order = order;
      });
    },
  }),
});

defineAbility({
  key: 'pugna_life_drain', target: 'unit', team: 'any', ult: true, reflectable: true, ai: { role: 'nuke' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    a.data.target = e.id; a.data.acc = 0; a.data.t = 0;
    a.data.ward = !!(hasShard(u) && e.owner === u && e.name === 'pugna_nether_ward');
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const e = u.w.units.get(a.data.target);
    const maxD = castRangeOf(a) + val(a, 'drain_buffer');
    if (!e || !e.alive || !u.w.targetable(e) || Math.hypot(e.x - u.x, e.y - u.y) > maxD || (e.team !== u.team && !u.w.canSee(u.team, e))) {
      u.w.interruptCast(u, true); return;
    }
    a.data.t += dt;
    a.data.acc += dt;
    const tick = val(a, 'tick_rate');
    if (a.data.acc < tick) return;
    a.data.acc -= tick;
    const healMult = 1 + val(a, 'bonus_heal_pct') / 100;
    const drainOne = (v: Unit, mult: number, rate: number) => {
      const got = damage(u, v, dmg(a, 'health_drain') * tick * mult, 'magical', a, { noProc: true });
      heal(u, got * healMult, u, true);
      u.w.addVision(u.team, v.x, v.y, 150, tick + 0.1);
      // Scepter: roba amplificación de hechizos.
      if (hasScepter(u) && v.kind === 'hero') {
        const d = val(a, 'spell_amp_drain_duration');
        const mv = v.addMod({ name: 'life_drain_amp_down', duration: d, debuff: true, purgable: false, data: { amt: 0 },
          props: (m) => ({ spellAmp: -m.data.amt }) }, u, a);
        mv.data.amt = Math.min(val(a, 'spell_amp_drain_max') / 100, mv.data.amt + rate * tick / 100);
        v.refreshStats();
        const mu = u.addMod({ name: 'life_drain_amp_up', duration: d, data: { amt: 0 }, props: (m) => ({ spellAmp: m.data.amt }) }, u, a);
        mu.data.amt = Math.min(val(a, 'max_spell_amp_drain_pct') / 100, mu.data.amt + rate * tick / 100);
        u.refreshStats();
      }
    };
    if (a.data.ward) {
      // Shard: se refracta desde la ward a todos los héroes enemigos cercanos.
      for (const v of u.w.enemiesIn(u.team, e.x, e.y, 700, { heroes: true })) {
        drainOne(v, val(a, 'shard_damage_pct_from_ward') / 100, val(a, 'spell_amp_drain_rate_ward'));
      }
      return;
    }
    if (e.team !== u.team) { drainOne(e, 1, val(a, 'spell_amp_drain_rate')); return; }
    // Aliado: Pugna le pasa su propia vida.
    const amt = val(a, 'ally_healing') * tick * a.upg.dmg;
    damage(u, u, amt, 'pure', a, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
    heal(e, amt * healMult, u, true);
  },
});

defineHero('pugna', ['pugna_nether_blast', 'pugna_decrepify', 'pugna_nether_ward', 'pugna_oblivion_savant', 'pugna_life_drain'], {
  build: ['null_talisman', 'arcane_boots', 'kaya', 'aether_lens', 'aghanims_shard', 'ultimate_scepter', 'octarine_core', 'sheepstick'],
});
