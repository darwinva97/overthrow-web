import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, manaCostOf, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { abil, deathGuard, idle, refund } from './lib/a7';
import { debuff, stun } from './util';

const BLAST = 'skeleton_king_hellfire_blast';
const BONES = 'skeleton_king_bone_guard';
const VAMP = 'skeleton_king_vampiric_spirit';
const REINC = 'skeleton_king_reincarnation';

/** Lanza Wraithfire Blast contra `e` (también desde Reincarnation con talento). */
function wraithfire(u: Unit, a: AbilityInst, e: Unit) {
  u.w.addProjectile({
    kind: 'track', fx: 'wraithfire_blast', source: u, target: e, x: u.x, y: u.y,
    speed: val(a, 'blast_speed'), dodgeable: true,
    onHit() {
      if (e.has(ST.magicImmune) && !a.def.bkbPierce) return true;
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      const s = dur(a, 'blast_stun_duration');
      stun(u, e, s, a);
      debuff(u, e, a, {
        name: 'wraithfire_dot', duration: s + val(a, 'blast_dot_duration'), fx: 'burn', interval: 1,
        props: { msSlow: Math.abs(val(a, 'blast_slow')) / 100 },
        onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'blast_dot_damage'), 'magical', a, { noProc: true }); },
      });
      return true;
    },
  });
}

defineAbility({
  key: 'skeleton_king_hellfire_blast', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) { wraithfire(a.owner as Unit, a, t.unit as Unit); },
});

/** Stats de un esqueleto de Wraith King (no están en units.json). */
function skeletonBase(dmgV: number): BaseStats {
  return {
    hp: 300, hpRegen: 0, mana: 0, manaRegen: 0, armor: 2, mr: 0, dmgMin: dmgV - 2, dmgMax: dmgV + 2,
    bat: 1.4, attackPoint: 0.56, range: 100, projSpeed: 900, ms: 340, dayVision: 800, nightVision: 800, turnRate: 0.9, melee: true,
  };
}

/** Invoca un esqueleto; si muere reaparece una vez tras `reincarnate_time`. */
function skeleton(u: Unit, x: number, y: number, target: Unit | null, respawned = false) {
  const bg = abil(u, BONES);
  const lvBg = bg && bg.level > 0 ? bg : null;
  const dmgV = lvBg ? val(lvBg, 'skeleton_damage_tooltip') : 34;
  const life = lvBg ? val(lvBg, 'skeleton_duration') : 40;
  const s = u.w.spawnSummon(u, skeletonBase(dmgV), x, y, life, {
    name: 'wraith_king_skeleton', bounty: lvBg ? val(lvBg, 'gold_bounty') : 5, xp: lvBg ? val(lvBg, 'xp_bounty') : 5,
  });
  const vamp = abil(u, VAMP);
  s.addMod({
    name: 'skeleton', persistent: true, fx: 'skeleton',
    props: { lifesteal: vamp ? val(vamp, 'vampiric_aura') / 100 : 0 },
    onAttackStart(_m, ev) { if ((ev.target as Unit).isHeroLike && lvBg) ev.damage *= 1 + val(lvBg, 'skeleton_bonus_hero_damage') / 100; },
    onDeath(m) {
      if (respawned || !u.alive) return;
      const v = m.owner as Unit;
      const left = v.expireAt - u.w.time;
      const delay = lvBg ? val(lvBg, 'reincarnate_time') : 3;
      if (left <= delay) return;
      u.w.after(delay, () => { if (u.alive) skeleton(u, v.x, v.y, null, true); });
    },
  }, u, bg ?? null);
  const tgt = target ?? u.w.enemiesIn(u.team, s.x, s.y, 900, { heroes: true })[0];
  if (tgt) u.w.issueOrder(s, { type: 'attack', target: tgt.id });
  return s;
}

defineAbility({
  key: 'skeleton_king_bone_guard', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  // Cuenta muertes: 1 por creep y `skeleton_charges_per_hero_multiplier` por héroe; 2 = 1 carga.
  passive: (a) => ({
    name: 'bone_guard_charges', stacks: a.data.charges ?? 0,
    onKill(m, victim) {
      if (victim.team === (m.owner as Unit).team) return;
      const n = victim.kind === 'hero' ? val(a, 'skeleton_charges_per_hero_multiplier') : victim.kind === 'creep' ? 1 : 0;
      a.data.kills = (a.data.kills ?? 0) + n;
      a.data.charges = Math.min(val(a, 'max_skeleton_charges'), Math.floor(a.data.kills / 2));
      if (a.data.charges >= val(a, 'max_skeleton_charges')) a.data.kills = a.data.charges * 2;
      m.stacks = a.data.charges;
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const n = Math.max(a.data.charges ?? 0, val(a, 'min_skeleton_spawn'));
    if (n <= 0) {
      if (u.isBot) { refund(a); idle(a, 5); } else refund(a);
      return;
    }
    a.data.charges = 0; a.data.kills = 0;
    if (a.passiveMod) a.passiveMod.stacks = 0;
    for (let i = 0; i < n; i++) {
      u.w.after(i * val(a, 'spawn_interval'), () => {
        if (!u.alive) return;
        const ang = u.facing + Math.PI + (u.w.rng() - 0.5) * 2;
        skeleton(u, u.x + Math.cos(ang) * 120, u.y + Math.sin(ang) * 120, null);
      });
    }
  },
});

// Ataques de Mortal Strike, para la maldición del Shard.
const struck = new WeakSet<AttackEvent>();

defineAbility({
  key: 'skeleton_king_mortal_strike', target: 'passive',
  passive: (a) => ({
    name: 'mortal_strike',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (a.cd > 0 || t.team === u.team || t.kind === 'ward') return;
      ev.critMult = Math.max(ev.critMult, val(a, 'crit_mult') / 100);
      a.cd = cooldownOf(a);
      struck.add(ev);
    },
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (!struck.has(ev) || !hasShard(u) || u.kind === 'illusion') return;
      // Shard: la víctima vuelve a recibir parte del golpe como daño puro.
      const amount = ev.damage * ev.critMult * val(a, 'curse_damage_pct') / 100;
      debuff(u, t, a, { name: 'mortal_strike_curse', duration: val(a, 'curse_delay'), fx: 'curse', purgable: false, data: { multi: true },
        onDestroy(m) {
          const v = m.owner as Unit;
          if (!v.alive || m.remaining > 0.05) return;
          const done = damage(u, v, amount, 'pure', a);
          const vamp = abil(u, VAMP);
          if (vamp && done > 0) heal(u, done * val(vamp, 'vampiric_aura') / 100, u, true);
        },
      });
    },
  }),
});

/** Reincarnation lista para salvar al héroe. */
function reincReady(u: Unit) {
  const a = abil(u, REINC);
  return !!a && a.level > 0 && a.cd <= 0 && u.mana >= manaCostOf(a) && u.kind === 'hero' && !u.findMod('wraith_form');
}

defineAbility({
  key: 'skeleton_king_vampiric_spirit', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'vampiric_spirit',
    props: { lifesteal: val(a, 'vampiric_aura') / 100 },
    // Scepter: también es un aura para los aliados.
    aura: hasScepter(a.owner as Unit) ? {
      radius: val(a, 'scepter_aura_radius'), team: 'ally', includeSelf: false,
      apply: () => ({ name: 'vampiric_spirit_aura', props: { lifesteal: val(a, 'vampiric_aura') / 100 } }),
    } : undefined,
    // Sin Reincarnation disponible, muere convertido en espectro tras unos segundos.
    ...deathGuard((u) => u.kind === 'hero' && !reincReady(u) && !u.findMod('wraith_form') && !u.findMod('reincarnating'), (u, ev) => {
      const killer = ev.source as Unit | null;
      u.w.emit({ n: 'wraith_form', x: u.x, y: u.y, u: u.id });
      u.addMod({
        name: 'wraith_form', duration: val(a, 'duration'), fx: 'wraith_form', purgable: false,
        states: ST.flying | ST.noCollision,
        props: { attackSpeed: val(a, 'scepter_attack_speed'), msPct: val(a, 'scepter_move_speed_pct') / 100 },
        onIncomingDamage(_m, e2) { e2.amount = 0; },
        onDestroy() {
          if (!u.alive) return;
          u.hp = 0;
          kill(u, killer);
        },
      }, u, a);
    }),
  }),
});

defineAbility({
  key: 'skeleton_king_reincarnation', target: 'unit', team: 'ally', allowSelf: true, ult: true,
  passive: (a) => ({
    name: 'reincarnation',
    ...deathGuard((u) => reincReady(u) && !u.findMod('reincarnating'), (u) => {
      a.cd = cooldownOf(a);
      u.mana -= manaCostOf(a);
      for (const m of [...u.mods]) if (m.debuff) u.removeMod(m);
      if (u.cast) u.w.interruptCast(u, true);
      u.order = null; u.atk.phase = 0;
      u.w.disjoint(u);
      const r = val(a, 'slow_radius');
      u.w.emit({ n: 'reincarnation', x: u.x, y: u.y, r, u: u.id, t: u.team });
      u.addMod({
        name: 'reincarnating', duration: val(a, 'reincarnate_time'), fx: 'reincarnating', purgable: false,
        states: ST.stunned | ST.invulnerable | ST.untargetable | ST.noCollision,
        onDestroy() {
          if (!u.alive) return;
          u.refreshStats();
          u.hp = u.s.maxHp; u.mana = u.s.maxMana;
          u.w.emit({ n: 'respawn', x: u.x, y: u.y, u: u.id });
        },
      }, u, a);
      const blast = abil(u, BLAST);
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
        debuff(u, e, a, {
          name: 'reincarnation_slow', duration: val(a, 'slow_duration'), fx: 'slow',
          props: { msSlow: Math.abs(val(a, 'movespeed')) / 100, attackSlow: Math.abs(val(a, 'attackslow')) },
        });
        if (e.kind !== 'hero') continue;
        // Esqueletos que van a por cada héroe cercano.
        for (let i = 0; i < val(a, 'shard_skeleton_count'); i++) {
          const ang = u.w.rng() * Math.PI * 2;
          skeleton(u, u.x + Math.cos(ang) * 100, u.y + Math.sin(ang) * 100, e);
        }
        // Talento: lanza Wraithfire Blast a cada héroe cercano.
        if (val(a, 'trigger_wraithfire_blast') > 0 && blast && blast.level > 0) wraithfire(u, blast, e);
      }
    }),
  }),
  // Autolanzado: muere al instante (y reencarna si puede).
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (t.unit !== u) { refund(a); return; }
    refund(a);
    damage(u, u, u.hp + 1, 'pure', a, { hpRemoval: true });
  },
});

defineHero('skeleton_king', [
  'skeleton_king_hellfire_blast', 'skeleton_king_bone_guard', 'skeleton_king_mortal_strike', 'skeleton_king_vampiric_spirit',
  'skeleton_king_reincarnation',
], {
  build: ['bracer', 'phase_boots', 'armlet', 'blink', 'black_king_bar', 'assault', 'abyssal_blade', 'ultimate_scepter'],
});
