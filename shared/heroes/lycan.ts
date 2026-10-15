// Lycan: Summon Wolves, Howl, Feral Impulse, Wolf Bite (Scepter), Apex Predator (innata) y Shapeshift.
import { UNITS } from '../data';
import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { heal } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { botBrain, heroOf, nearestEnemyHero, ready, summonFollow } from './lib/a4';
import { debuff, dot } from './util';

const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Lobos vivos de Lycan. */
const wolvesOf = (u: Unit) => u.w.list.filter((s) => s.alive && s.owner === u && s.data_lycanWolf);

/** Unidades bajo el control de Lycan (invocaciones, creeps dominados) y el aliado mordido. */
function packOf(u: Unit): Unit[] {
  const out = u.w.list.filter((s) => s.alive && s !== u && (s.kind === 'summon' || s.kind === 'creep') && heroOf(s) === u);
  const bitten = u.w.units.get(u.data_bitten ?? 0);
  if (bitten && bitten.alive && bitten.findMod('wolf_bite', u)) out.push(bitten);
  return out;
}

/** Crítico de Shapeshift (Lycan, sus unidades y el mordido). */
function shapeshiftSpec(a: AbilityInst, name: string, duration: number): ModSpec {
  return {
    name, duration, fx: 'shapeshift',
    props: () => ({
      msFixed: val(a, 'speed'), slowResist: 1,
      vision: (a.owner as Unit).w.isNight() ? val(a, 'bonus_night_vision') : 0,
    }),
    onAttackStart(m, ev) {
      if ((m.owner as Unit).w.rng() < val(a, 'crit_chance') / 100) {
        ev.critMult = Math.max(ev.critMult, val(a, 'crit_multiplier') / 100);
      }
    },
  };
}

// ---------------- Summon Wolves ----------------

defineAbility({
  key: 'lycan_summon_wolves', target: 'none', ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    // Los lobos anteriores mueren al volver a invocar.
    for (const s of wolvesOf(u)) s.expireAt = w.time;
    const idx = Math.max(1, Math.min(6, a.level));
    const key = `lycan_wolf${idx}`;
    const d = UNITS[key];
    const abilities: string[] = [];
    if (a.level >= 3) abilities.push('lycan_summon_wolves_invisibility');
    if (a.level >= 4) abilities.push('lycan_summon_wolves_critical_strike');
    if (val(a, 'give_wolves_hightail') > 0) abilities.push('lycan_summon_wolves_hightail');
    const n = val(a, 'wolf_count');
    for (let i = 0; i < n; i++) {
      const ang = u.facing + (i - (n - 1) / 2) * 0.8;
      const base: BaseStats = {
        hp: val(a, 'wolf_hp'), hpRegen: d.hpRegen, mana: d.mana, manaRegen: d.manaRegen,
        armor: d.armor + val(a, 'bonus_armor'), mr: d.mr,
        dmgMin: dmg(a, 'wolf_damage'), dmgMax: dmg(a, 'wolf_damage'), bat: val(a, 'wolf_bat'),
        attackPoint: d.attackPoint, range: d.range, projSpeed: d.projSpeed, ms: d.ms,
        dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: d.melee,
      };
      const s = w.spawnSummon(u, base, u.x + Math.cos(ang) * 120, u.y + Math.sin(ang) * 120, dur(a, 'wolf_duration'), {
        name: key, abilities, level: 1, bounty: d.bountyGold, xp: d.bountyXp,
      });
      s.data_lycanWolf = true;
      s.addMod(summonFollow(s), u, a);
    }
    w.emit({ n: 'summon_wolves', x: u.x, y: u.y, u: u.id, t: u.team });
  },
});

defineAbility({
  key: 'lycan_summon_wolves_invisibility', target: 'passive',
  passive: (a) => ({
    name: 'wolf_invis_watch', data: { last: -99 },
    onAttackStart(m) { m.data.last = (m.owner as Unit).w.time; },
    onTick(m) {
      const s = m.owner as Unit;
      if (s.findMod('wolf_invis') || s.w.time - m.data.last < val(a, 'fade_delay')) return;
      s.addMod({ name: 'wolf_invis', states: ST.invisible, fx: 'invisible', data: { breaksOnAttack: true } }, s, a);
    },
  }),
});

defineAbility({
  key: 'lycan_summon_wolves_critical_strike', target: 'passive',
  passive: (a) => ({
    name: 'wolf_cripple',
    onAttackLanded(m, ev) {
      const s = m.owner as Unit, t = ev.target as Unit;
      if (t.team === s.team || s.w.rng() >= val(a, 'maim_chance') / 100) return;
      dot(s, t, a, 'wolf_cripple', val(a, 'maim_duration'), val(a, 'maim_damage'), 'magical', 1, {
        props: { msSlow: val(a, 'maim_movement_speed') / 100, attackSlow: val(a, 'maim_attack_speed') },
      });
    },
  }),
});

defineAbility({
  key: 'lycan_summon_wolves_hightail', target: 'none',
  // Lobos de un bot: lo usan al entrar en pelea.
  passive: (a) => ({
    name: 'hightail_brain',
    onTick(m, dt) {
      m.data.t = (m.data.t ?? 0) - dt;
      if (m.data.t > 0) return;
      m.data.t = 0.5;
      const s = m.owner as Unit;
      if (!(s.owner as Unit | null)?.isBot || !s.alive || !ready(a)) return;
      if (nearestEnemyHero(s, 700)) s.w.issueOrder(s, { type: 'cast', slot: a.slot });
    },
  }),
  onSpellStart(a) {
    const s = a.owner as Unit;
    s.addMod({
      name: 'hightail', duration: dur(a, 'duration'), fx: 'haste', states: ST.noCollision,
      props: { evasion: val(a, 'evasion') / 100, msFixed: val(a, 'min_movespeed'), attackSpeed: val(a, 'bonus_attack_speed') },
    }, s, a);
  },
});

// ---------------- Howl ----------------

defineAbility({
  key: 'lycan_howl', target: 'none', ai: { role: 'aoe', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const r = val(a, 'radius');
    const hit = new Set<Unit>();
    // De noche es global; de día, alrededor de Lycan y de sus lobos.
    if (w.isNight()) {
      for (const e of w.list) if (e.alive && e.team !== u.team && w.targetable(e) && (e.isHeroLike || e.kind === 'creep' || e.kind === 'summon')) hit.add(e);
    } else {
      for (const src of [u, ...wolvesOf(u)]) for (const e of w.enemiesIn(u.team, src.x, src.y, r)) if (e.kind !== 'ward') hit.add(e);
    }
    w.emit({ n: 'howl', x: u.x, y: u.y, r, u: u.id, t: u.team });
    const red = val(a, 'attack_damage_reduction') / 100;
    const total = val(a, 'total_attack_damage_reduction') > 0;
    for (const e of hit) {
      debuff(u, e, a, {
        name: 'howl', duration: dur(a, 'howl_duration'), fx: 'howl',
        // Sin talento reduce el daño base; con él, el daño total del ataque.
        props: { armor: -val(a, 'armor'), damagePct: total ? 0 : -red },
        onAttackStart: total ? (_m, ev) => { ev.damage *= 1 - red; } : undefined,
      });
    }
  },
});

// ---------------- Feral Impulse y Apex Predator (auras sobre su manada) ----------------

/** Reparte cada 0,5 s un buff corto a Lycan y a las unidades que controla. */
function packAura(name: string, spec: (u: Unit) => ModSpec): ModSpec {
  return {
    name: name + '_src', interval: 0.5,
    onCreated(m) { m.onInterval?.(m); },
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.alive) return;
      for (const s of [u, ...packOf(u)]) s.addMod({ duration: 1, ...spec(u) }, u, m.ability);
    },
  };
}

defineAbility({
  key: 'lycan_feral_impulse', target: 'passive', noIllusion: true,
  passive: (a) => packAura('feral_impulse', () => ({
    name: 'feral_impulse', props: { damagePct: val(a, 'bonus_damage') / 100, hpRegen: val(a, 'bonus_hp_regen') },
  })),
});

defineAbility({
  key: 'lycan_apex_predator', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => packAura('apex_predator', () => ({
    name: 'apex_predator',
    // Más daño contra creeps neutrales (equipo neutral = negativo).
    onAttackStart(_m, ev) { if (ev.target.team < 0 && ev.target.kind === 'creep') ev.damage *= 1 + val(a, 'damage_amp') / 100; },
  })),
});

// ---------------- Wolf Bite (Scepter) ----------------

defineAbility({
  key: 'lycan_wolf_bite', target: 'unit', team: 'ally',
  passive: (a) => botBrain(a, (u) => {
    if (!nearestEnemyHero(u, 1200)) return null;
    const al = u.w.alliesIn(u.team, u.x, u.y, val(a, 'abilitycastrange') + 400, { heroes: true })
      .find((x) => x !== u && x.kind === 'hero');
    return al ? { target: al } : null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e || e === u) return;
    const old = u.w.units.get(u.data_bitten ?? 0);
    old?.removeModsByName('wolf_bite');
    u.data_bitten = e.id;
    const range = val(a, 'lifesteal_range');
    const ls = val(a, 'lifesteal_percent') / 100;
    // Ambos roban vida y comparten la curación mientras estén cerca.
    const link = (self: Unit, other: () => Unit | null | undefined): ModSpec => ({
      name: 'wolf_bite', fx: 'wolf_bite',
      props: () => {
        const o = other();
        return { lifesteal: o && o.alive && Math.hypot(o.x - self.x, o.y - self.y) <= range ? ls : 0 };
      },
      interval: 0.5,
      onInterval(m) {
        const o = m.owner as Unit;
        if (o !== u && !u.alive) { o.removeMod(m); return; }
        o.refreshStats();
      },
      onDealDamage(_m, ev) {
        const o = other();
        if (!ev.isAttack || ev.noProc || !o || !o.alive || Math.hypot(o.x - self.x, o.y - self.y) > range) return;
        heal(o, ev.amount * ls, self, true);
      },
    });
    e.addMod(link(e, () => u), u, a);
    u.removeModsByName('wolf_bite_self');
    u.addMod({ ...link(u, () => u.w.units.get(u.data_bitten ?? 0)), name: 'wolf_bite_self' }, u, a);
    u.w.emit({ n: 'wolf_bite', x: e.x, y: e.y, u: e.id, u2: u.id, t: u.team });
  },
});

// ---------------- Shapeshift ----------------

defineAbility({
  key: 'lycan_shapeshift', target: 'none', ult: true, ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'shapeshift', x: u.x, y: u.y, u: u.id, t: u.team });
    u.addMod({
      name: 'shapeshift_transform', duration: val(a, 'transformation_time'), states: ST.busy, fx: 'transform',
      onDestroy() {
        if (!u.alive) return;
        u.addMod({
          ...shapeshiftSpec(a, 'shapeshift', dur(a, 'duration')),
          props: () => ({
            msFixed: val(a, 'speed'), slowResist: 1, hp: val(a, 'health_bonus'),
            vision: u.w.isNight() ? val(a, 'bonus_night_vision') : 0,
          }),
          interval: 0.25,
          // También para lobos, unidades controladas y el aliado mordido.
          onInterval() { for (const s of packOf(u)) s.addMod(shapeshiftSpec(a, 'shapeshift_pack', 0.5), u, a); },
        }, u, a);
      },
    }, u, a);
  },
});

defineHero('lycan', ['lycan_summon_wolves', 'lycan_howl', 'lycan_feral_impulse', 'lycan_wolf_bite', 'lycan_apex_predator', 'lycan_shapeshift'], {
  build: ['bracer', 'phase_boots', 'echo_sabre', 'black_king_bar', 'basher', 'assault', 'abyssal_blade'],
});
