import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dist, flying, setSummonStats, summonBrain } from './lib/a9';
import { canDebuff, debuff, stun } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const isFamiliar = (s: Unit) => s.kind === 'summon' && s.name.startsWith('visage_familiar');
function familiarsOf(u: Unit) { return u.w.list.filter((s) => s.alive && s.owner === u && isFamiliar(s)); }
/** Visage dueño de un familiar (o él mismo). */
const visageOf = (u: Unit) => (isFamiliar(u) && u.owner ? (u.owner as Unit) : u);

/** Corrupción de armadura del talento: cada golpe de Visage o un familiar quita armadura. */
function armorCorruption(ev: AttackEvent) {
  const by = ev.attacker as Unit, t = ev.target as Unit;
  const v = visageOf(by);
  const fam = ab(v, 'visage_summon_familiars');
  if (!fam || fam.level <= 0 || t.team === by.team) return;
  const per = val(fam, 'armor_reduction_per_hit');
  if (per <= 0) return;
  const cur = t.findMod('visage_corruption', v);
  const m = debuff(v, t, fam, {
    name: 'visage_corruption', duration: val(fam, 'armor_reduction_duration'), stacks: (cur?.stacks ?? 0) + 1,
    props: (mm) => ({ armor: -per * mm.stacks }),
  });
  if (m) t.refreshStats();
}

defineAbility({
  key: 'visage_grave_chill', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'chill_duration');
    const ms = val(a, 'movespeed_bonus'), as = val(a, 'attackspeed_bonus');
    debuff(u, e, a, { name: 'grave_chill', duration: d, fx: 'slow', props: { msSlow: ms / 100, attackSlow: as } });
    for (const x of [u, ...familiarsOf(u).filter((f) => dist(f, u) <= val(a, 'radius'))]) {
      x.addMod({ name: 'grave_chill_buff', duration: d, props: { msPct: ms / 100, attackSpeed: as } }, u, a);
    }
  },
});

defineAbility({
  key: 'visage_soul_assumption', target: 'unit', reflectable: true, noIllusion: true, ai: { role: 'nuke' },
  // Escucha el daño que reciben los héroes cercanos y acumula cargas.
  passive: (a) => ({
    name: 'soul_assumption', stacks: 0, interval: 0.2,
    data: { charges: [] as number[] },
    onInterval(m) {
      const u = m.owner as Unit;
      const now = u.w.time;
      m.data.charges = (m.data.charges as number[]).filter((t) => t > now);
      if (m.stacks !== m.data.charges.length) m.stacks = m.data.charges.length;
      if (!u.alive) return;
      for (const h of u.w.unitsIn(u.x, u.y, val(a, 'radius'), (x) => x.kind === 'hero')) {
        h.addMod({
          name: 'soul_assumption_listener', duration: 0.5,
          onTakeDamage(_mm, ev) {
            if (ev.amount < val(a, 'damage_limit') || ev.amount > val(a, 'damage_max')) return;
            const c = m.data.charges as number[];
            if (c.length >= val(a, 'stack_limit')) c.shift();
            c.push(u.w.time + val(a, 'stack_duration'));
            m.stacks = c.length;
          },
        }, u, a);
      }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const m = a.passiveMod;
    const charges = m ? (m.data.charges as number[]).length : 0;
    if (m && !a.temp) { m.data.charges = []; m.stacks = 0; }
    const total = dmg(a, 'soul_base_damage') + charges * dmg(a, 'soul_charge_damage');
    const targets = [e, ...u.w.enemiesIn(u.team, u.x, u.y, val(a, 'abilitycastrange') + u.s.castRange, { heroes: true })
      .filter((x) => x !== e && u.w.canSee(u.team, x))].slice(0, val(a, 'target_count'));
    for (const v of targets) {
      u.w.addProjectile({
        kind: 'track', fx: 'soul_assumption', source: u, target: v, x: u.x, y: u.y, speed: val(a, 'bolt_speed'), dodgeable: true,
        onHit() { if (canDebuff(u, v, a)) damage(u, v, total, 'magical', a); return true; },
      });
    }
  },
});

/** Reducción de daño de la capa según las capas que le quedan a Visage. */
function cloakReduction(a: AbilityInst, layers: number) {
  return Math.min(val(a, 'max_damage_reduction'), layers * val(a, 'damage_reduction')) / 100;
}

/** Stone Form (familiar o Visage con Shard): golpe tras un retardo e invulnerable regenerando. */
function stoneForm(a: AbilityInst, s: Unit, hpPerSec: number, duration: number) {
  const w = s.w;
  const owner = visageOf(s);
  s.order = null; s.atk.phase = 0;
  s.addMod({
    name: 'stone_form', duration, fx: 'stone_form', purgable: false,
    states: ST.stunned | ST.invulnerable | ST.noCollision,
    onTick(_m, dt) { heal(s, hpPerSec * dt, s, true); },
  }, s, a);
  w.after(val(a, 'stun_delay'), () => {
    if (!s.alive) return;
    const r = val(a, 'stun_radius');
    w.emit({ n: 'stone_form', x: s.x, y: s.y, r, t: s.team });
    for (const e of w.enemiesIn(s.team, s.x, s.y, r)) {
      damage(owner, e, dmg(a, 'stun_damage'), 'magical', a);
      stun(owner, e, dur(a, 'stun_duration'), a);
    }
  });
}

defineAbility({
  key: 'visage_gravekeepers_cloak', target: 'none', ai: { role: 'buff', selfRadius: 350 },
  passive: (a) => ({
    name: 'gravekeepers_cloak', stacks: val(a, 'max_layers'),
    data: { recover: [] as number[] },
    onTick(m) {
      const u = m.owner as Unit;
      const r = m.data.recover as number[];
      while (r.length && r[0] <= u.w.time) { r.shift(); m.stacks = Math.min(val(a, 'max_layers'), m.stacks + 1); }
    },
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (ev.hpRemoval || ev.amount <= 0) return;
      const raw = ev.amount;
      ev.amount *= 1 - cloakReduction(a, m.stacks);
      const src = ev.source as Unit | null;
      const fromPlayer = !!src && src.team !== u.team && (!!src.playerId || !!creditHero(src));
      if (fromPlayer && raw >= val(a, 'minimum_damage') && m.stacks > 0) {
        m.stacks--;
        (m.data.recover as number[]).push(u.w.time + val(a, 'recovery_time'));
      }
    },
    // Los familiares cercanos se protegen con las capas de Visage.
    aura: {
      radius: val(a, 'radius'), team: 'ally', includeSelf: false,
      apply(m, t) {
        if (!isFamiliar(t as Unit) || t.owner !== m.owner) return { name: 'gravekeepers_cloak_none' };
        const red = cloakReduction(a, m.stacks);
        return {
          name: 'gravekeepers_cloak_familiar',
          onIncomingDamage(_mm, ev) { if (!ev.hpRemoval) ev.amount *= 1 - red; },
        };
      },
    },
  }),
  // Shard: Visage se convierte en piedra.
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!hasShard(u) || a.temp) return;
    const mc = val(a, 'shard_manacost');
    if (u.mana < mc) return;
    u.mana -= mc;
    a.cd = val(a, 'shard_cooldown') * a.upg.cd * (1 - u.s.cdr);
    const stone = ab(u, 'visage_summon_familiars_stone_form');
    const lvl = stone ? stone : a;
    const d = val(lvl, 'stone_duration');
    stoneForm(lvl, u, u.s.maxHp * val(a, 'shard_hp_restoration_pct') / 100 / d, d);
  },
});

defineAbility({
  key: 'visage_stone_form_self_cast', target: 'none', levelWith: 5, ai: { role: 'disable', selfRadius: 350 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const fam = familiarsOf(u).filter((f) => {
      const s = ab(f, 'visage_summon_familiars_stone_form');
      return s && !u.w.castCheck(f, s);
    }).sort((p, q) => dist(p, u) - dist(q, u))[0];
    if (!fam) return;
    const s = ab(fam, 'visage_summon_familiars_stone_form')!;
    u.w.issueOrder(fam, { type: 'cast', slot: s.slot });
  },
});

defineAbility({
  key: 'visage_silent_as_the_grave', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 1200 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const invis = val(a, 'invis') > 0;
    const d = dur(a, 'flight_duration');
    const grant = () => {
      for (const x of [u, ...familiarsOf(u)]) {
        x.addMod({
          name: 'silent_as_the_grave_damage', duration: val(a, 'bonus_duration'),
          onAttackStart(_m, ev) { ev.damage *= 1 + val(a, 'bonus_damage') / 100; },
        }, u, a);
      }
    };
    u.addMod({
      name: 'silent_as_the_grave', duration: d, fx: invis ? 'invis' : 'flying',
      states: ST.flying | ST.noCollision | (invis ? ST.invisible : 0),
      props: { msPct: val(a, 'movespeed_bonus') / 100 },
      data: { breaksOnAttack: true },
      onDestroy(m) { if (m.remaining > 0.05) grant(); },
    }, u, a);
    if (invis) {
      for (const f of familiarsOf(u)) {
        f.addMod({ name: 'silent_as_the_grave', duration: d, fx: 'invis', states: ST.invisible, data: { breaksOnAttack: true } }, u, a);
      }
    }
  },
});

defineAbility({
  key: 'visage_summon_familiars', target: 'none', ult: true, ai: { role: 'summon', selfRadius: 1200 },
  passive: (a) => ({
    name: 'visage_familiars_bonus',
    props: { damage: val(a, 'visage_base_damage') },
    onAttackLanded(_m, ev) { armorCorruption(ev); },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    for (const f of familiarsOf(u)) f.expireAt = u.w.time;
    const n = val(a, 'familiar_count');
    const key = `visage_familiar${Math.min(3, Math.max(1, a.level))}`;
    for (let i = 0; i < n; i++) {
      const side = (i % 2 ? 1 : -1) * val(a, 'side_distance') * (1 + Math.floor(i / 2));
      const bx = u.x - Math.cos(u.facing) * val(a, 'back_distance'), by = u.y - Math.sin(u.facing) * val(a, 'back_distance');
      const f = u.w.spawnSummon(u, key, bx - Math.sin(u.facing) * side, by + Math.cos(u.facing) * side, Infinity, {
        abilities: ['visage_summon_familiars_stone_form', 'visage_summon_familiars_recall'], level: a.level,
        bounty: val(a, 'familiar_bounty'),
      });
      setSummonStats(f, {
        hp: val(a, 'familiar_hp'), armor: val(a, 'familiar_armor'), dmg: val(a, 'familiar_attack_damage'),
        ms: val(a, 'familiar_base_movespeed'), range: val(a, 'familiar_attack_range'),
      });
      flying(f);
      f.addMod({ name: 'familiar', persistent: true, onAttackLanded(_m, ev) { armorCorruption(ev); } }, u, a);
      summonBrain(f, u, 900, (s) => {
        const st = ab(s, 'visage_summon_familiars_stone_form');
        if (!st || s.w.castCheck(s, st)) return;
        const close = s.w.enemiesIn(s.team, s.x, s.y, val(st, 'stun_radius') - 75, { heroes: true }).length > 0;
        if (close || s.hp / s.s.maxHp < 0.35) s.w.issueOrder(s, { type: 'cast', slot: st.slot });
      });
    }
  },
});

defineAbility({
  key: 'visage_summon_familiars_stone_form', target: 'none', sub: true,
  // En el héroe solo figura en el kit; la lanzan los familiares.
  hidden: (a) => !isFamiliar(a.owner as Unit),
  onSpellStart(a) {
    const s = a.owner as Unit;
    if (!isFamiliar(s)) return;
    stoneForm(a, s, val(a, 'hp_regen'), val(a, 'stone_duration'));
  },
});

// Habilidad propia de los familiares (no está en el kit del héroe).
defineAbility({
  key: 'visage_summon_familiars_recall', target: 'none',
  onSpellStart(a) {
    const s = a.owner as Unit;
    const v = visageOf(s);
    s.addMod({
      name: 'familiar_recall', duration: val(a, 'recall_duration'), states: ST.busy | ST.disarmed, fx: 'recall',
      onDestroy() { if (s.alive && v.alive) s.w.teleport(s, v.x + 60, v.y); },
    }, s, a);
  },
});

defineHero('visage', ['visage_grave_chill', 'visage_soul_assumption', 'visage_gravekeepers_cloak', 'visage_stone_form_self_cast',
  'visage_silent_as_the_grave', 'visage_summon_familiars', 'visage_summon_familiars_stone_form'], {
  build: ['bracer', 'arcane_boots', 'force_staff', 'orchid', 'black_king_bar', 'ultimate_scepter', 'sheepstick'],
});
