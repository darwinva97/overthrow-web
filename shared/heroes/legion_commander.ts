import { cooldownOf, defineAbility, defineHero, dmg, dur, isItem, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, hurtAlly, nearestEnemyHero } from './lib/a4';
import { canDebuff, debuff, slow } from './util';

const ptaOf = (u: Unit) => u.abilities.find((x) => x.key === 'legion_commander_press_the_attack');

/** Barrera que absorbe cualquier daño hasta agotarse. */
function barrier(name: string, amount: number, duration: number, fx: string): ModSpec {
  return {
    name, duration, fx, data: { hp: amount },
    onIncomingDamage(m, ev) {
      if (m.data.hp <= 0 || ev.amount <= 0) return;
      const b = Math.min(m.data.hp, ev.amount);
      ev.amount -= b;
      m.data.hp -= b;
      if (m.data.hp <= 0) m.remaining = 0.001;
    },
  };
}

/** Press the Attack sobre `t` (y alrededor, con Scepter): disipación fuerte, velocidad y regeneración. */
function pressTheAttack(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  const targets = r > 0 ? u.w.alliesIn(u.team, t.x, t.y, r).filter((x) => x.kind !== 'ward') : [t];
  if (!targets.includes(t)) targets.push(t);
  u.w.emit({ n: 'press_the_attack', x: t.x, y: t.y, r: r || 100, u: t.id, t: u.team });
  for (const al of targets) {
    al.purge(true, false, true);
    if (al.cast?.phase === 2 && al.has(ST.stunned)) al.w.interruptCast(al, true);
    al.addMod({
      name: 'press_the_attack', duration: dur(a, 'duration'), fx: 'press_the_attack',
      props: { msPct: val(a, 'move_speed') / 100, hpRegen: val(a, 'hp_regen') },
    }, u, a);
    // Talento: inmunidad a debuffs al principio.
    const imm = val(a, 'immunity_duration');
    if (imm > 0) {
      al.addMod({
        name: 'press_the_attack_immunity', duration: imm, fx: 'magic_immune', states: ST.magicImmune,
        props: { magicResist: val(a, 'immunity_resist') / 100 },
      }, u, a);
    }
  }
}

defineAbility({
  key: 'legion_commander_overwhelming_odds', target: 'none', ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const list = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => canDebuff(u, e, a));
    const heroes = list.filter((e) => e.kind === 'hero').length;
    const units = list.length - heroes;
    // El daño crece con cada héroe y cada unidad del área.
    const total = dmg(a, 'damage') + dmg(a, 'damage_per_hero') * heroes + dmg(a, 'damage_per_unit') * units;
    u.w.emit({ n: 'overwhelming_odds', x: u.x, y: u.y, r, u: u.id, t: u.team });
    let toHeroes = 0;
    for (const e of list) {
      const d = damage(u, e, total, 'magical', a);
      if (e.kind === 'hero' || val(a, 'shield_counts_non_hero_damage') > 0) toHeroes += d;
      slow(u, e, a, 'overwhelming_odds_slow', val(a, 'slow_duration'), val(a, 'movement_slow') / 100);
    }
    if (heroes > 0) {
      u.addMod({
        name: 'overwhelming_odds_speed', duration: dur(a, 'duration'), fx: 'overwhelming_odds', stacks: heroes,
        props: { attackSpeed: val(a, 'bonus_attack_speed') * heroes },
      }, u, a);
    }
    // Shard: barrera según el daño hecho a héroes.
    const pct = val(a, 'shield_per_damage_pct');
    if (pct > 0 && toHeroes > 0) {
      u.addMod(barrier('overwhelming_odds_shield', toHeroes * pct / 100, val(a, 'shield_duration'), 'barrier'), u, a);
    }
  },
});

defineAbility({
  key: 'legion_commander_press_the_attack', target: 'unit', team: 'ally', allowSelf: true,
  onSpellStart(a, t) { if (t.unit) pressTheAttack(a, t.unit as Unit); },
  // Bot: sobre sí misma o un aliado herido o con debuffs en plena pelea.
  passive: (a) => botBrain(a, (u) => {
    if (!nearestEnemyHero(u, 900)) return null;
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, range, { heroes: true })) {
      if (al.kind !== 'hero') continue;
      if (al.mods.some((m) => m.debuff && m.caster && m.caster.team !== u.team && Number.isFinite(m.remaining) && m.remaining > 0.8)) return { target: al };
    }
    const hurt = hurtAlly(u, range, 0.65);
    return hurt ? { target: hurt } : null;
  }),
});

defineAbility({
  key: 'legion_commander_moment_of_courage', target: 'passive',
  passive: (a) => ({
    name: 'moment_of_courage', data: { count: 0, leech: false },
    onAttacked(m, ev) {
      const u = m.owner as Unit;
      const t = ev.attacker as Unit;
      if (t.team === u.team || a.cd > 0 || !u.alive) return;
      m.data.count++;
      m.stacks = m.data.count;
      if (m.data.count < val(a, 'trigger_attacks')) return;
      if (u.has(ST.stunned) || u.has(ST.disarmed) || !t.alive || !u.w.targetable(t)) return;
      if (Math.hypot(t.x - u.x, t.y - u.y) > u.s.attackRange + u.radius + t.radius + 50) return;
      m.data.count = 0; m.stacks = 0;
      a.cd = cooldownOf(a);
      // Contraataque instantáneo con robo de vida.
      m.data.leech = true;
      u.w.emit({ n: 'moment_of_courage', x: u.x, y: u.y, u: u.id, u2: t.id });
      launchAttack(u, t, true);
      m.data.leech = false;
    },
    onDealDamage(m, ev) {
      if (!m.data.leech || !ev.isAttack) return;
      const u = m.owner as Unit;
      heal(u, ev.amount * val(a, 'hp_leech_percent') / 100 * val(a, 'secondary_attack_damage') / 100, u);
    },
  }),
});

/** Armadura de Outfight Them! al lanzar una habilidad (las instancias se apilan por separado). */
function outfightBuff(a: AbilityInst, t: Unit, factor: number) {
  t.addMod({
    name: 'outfight_them_armor', duration: val(a, 'duration'), data: { multi: true },
    props: { armor: val(a, 'armor') * factor },
  }, a.owner as Unit, a);
}

defineAbility({
  key: 'legion_commander_outfight_them', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'outfight_them',
    onAbilityExecuted(_m, ab) { if (!isItem(ab)) outfightBuff(a, a.owner as Unit, 1); },
    aura: {
      radius: val(a, 'radius'), team: 'ally', heroesOnly: true, includeSelf: false,
      apply: () => ({
        name: 'outfight_them_ally',
        onAbilityExecuted(m, ab) { if (!isItem(ab)) outfightBuff(a, m.owner as Unit, val(a, 'ally_factor') / 100); },
      }),
    },
  }),
});

defineAbility({
  key: 'legion_commander_duel', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  passive: (a) => ({
    name: 'duel_damage', stacks: a.data.wins ?? 0,
    props: () => ({ damage: a.data.bonus ?? 0 }),
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e || !e.alive) return;
    const d = dur(a, 'duration');
    const st = { done: false };
    let mine: ReturnType<Unit['addMod']> | null = null;
    // Gana quien sobrevive: daño permanente.
    const win = (winner: Unit) => {
      if (st.done) return;
      st.done = true;
      const reward = val(a, 'reward_damage');
      u.w.emit({ n: 'duel_win', x: winner.x, y: winner.y, u: winner.id });
      if (winner === u) {
        if (!a.temp) {
          a.data.wins = (a.data.wins ?? 0) + 1;
          a.data.bonus = (a.data.bonus ?? 0) + reward;
          if (a.passiveMod) a.passiveMod.stacks = a.data.wins;
          u.refreshStats();
          if (val(a, 'duel_refresh_on_victory') > 0) a.cd = 0;
        }
        // Scepter: Press the Attack automático alrededor.
        const pta = ptaOf(u);
        if (val(a, 'trigger_pta_on_victory') > 0 && pta && pta.level > 0 && u.alive) pressTheAttack(pta, u);
      } else {
        const m = winner.findMod('duel_won') ?? winner.addMod({
          name: 'duel_won', persistent: true, data: { dmg: 0 },
          props: (mm) => ({ damage: mm.data.dmg }),
        }, winner, null);
        m.data.dmg += reward;
        m.stacks = Math.round(m.data.dmg);
        winner.refreshStats();
      }
    };
    const theirs = debuff(u, e, a, {
      name: 'taunt', duration: d, purgable: false, fx: 'duel',
      states: ST.taunted | ST.silenced | ST.muted,
      onDeath() { win(u); },
      onDestroy() { if (mine) u.removeMod(mine); },
    });
    if (!theirs) return;
    // La duración del duelo no la reduce la resistencia a efectos.
    theirs.remaining = theirs.duration = d;
    if (e.cast) e.w.interruptCast(e, true);
    e.order = null;
    mine = u.addMod({
      name: 'taunt', duration: d, purgable: false, fx: 'duel', states: ST.taunted | ST.muted,
      onDeath() { win(e); },
      onDestroy() { if (theirs.owner?.mods.includes(theirs)) e.removeMod(theirs); },
    }, e, a);
    u.w.emit({ n: 'duel', x: (u.x + e.x) / 2, y: (u.y + e.y) / 2, u: u.id, u2: e.id });
  },
});

defineHero('legion_commander', [
  'legion_commander_overwhelming_odds', 'legion_commander_press_the_attack', 'legion_commander_moment_of_courage',
  'legion_commander_outfight_them', 'legion_commander_duel',
], {
  build: ['bracer', 'phase_boots', 'blink', 'blade_mail', 'black_king_bar', 'desolator', 'assault'],
});
