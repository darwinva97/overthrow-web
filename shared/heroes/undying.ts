import { defineAbility, defineHero, dmg, dur, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { expire, isUnitLike } from './lib/a8';
import { debuff, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const isTomb = (v: Unit) => v.name.startsWith('unit_tombstone');

defineAbility({
  key: 'undying_decay', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const D = dur(a, 'abilityduration');
    const steal = val(a, 'str_steal');
    u.w.emit({ n: 'decay', x: t.x, y: t.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      if (e.kind === 'ward') continue;
      damage(u, e, dmg(a, 'decay_damage') * (e.isHeroLike ? 1 : val(a, 'creep_damage_multiplier')), 'magical', a);
      if (e.kind !== 'hero' || !e.alive) continue;
      // Cada robo de fuerza es una instancia con su propia duración.
      if (!debuff(u, e, a, { name: 'decay_loss', duration: D, data: { multi: true }, props: { str: -steal } })) continue;
      u.addMod({ name: 'decay_gain', duration: D, data: { multi: true }, fx: 'decay', props: { str: steal } }, u, a);
    }
  },
});

defineAbility({
  key: 'undying_soul_rip', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const e = t.unit as Unit;
    if (isTomb(e) && e.owner === u) {
      e.hp = Math.min(e.s.maxHp, e.hp + val(a, 'tombstone_heal'));
      return;
    }
    const list = w.unitsIn(u.x, u.y, val(a, 'radius'), (v) => v !== u && v !== e && isUnitLike(v) && w.targetable(v) && !v.has(ST.invulnerable))
      .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))
      .slice(0, val(a, 'max_units'));
    const per = dmg(a, 'damage_per_unit');
    for (const v of list) damage(u, v, per, 'magical', a, { noProc: true, hpRemoval: v.team === u.team, data: { nonLethal: true } });
    const amount = per * list.length;
    w.emit({ n: 'soul_rip', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    if (e.team === u.team) heal(e, amount, u);
    else damage(u, e, amount, 'magical', a);
  },
});

/** Zombi junto a un enemigo, que le ataca. */
function zombie(u: Unit, tomb: AbilityInst, e: Unit, duration: number, alive: () => boolean) {
  const w = u.w;
  const ang = w.rng() * Math.PI * 2;
  const pad = 36 + e.radius;
  const z = w.spawnSummon(u, w.rng() < 0.5 ? 'unit_undying_zombie' : 'unit_undying_zombie_torso',
    e.x + Math.cos(ang) * pad, e.y + Math.sin(ang) * pad, duration, { level: Math.max(1, tomb.level) });
  z.addMod({
    name: 'zombie', persistent: true, states: ST.magicImmune,
    props: { damage: val(tomb, 'zombie_bonus_damage') },
    // Mueren a golpes: los héroes los tumban de uno.
    onIncomingDamage(_m, ev) {
      if (!ev.isAttack) { ev.amount = 0; return; }
      ev.amount = (ev.source as Unit)?.isHeroLike ? z.hp : 1;
    },
    onTick() { if (!alive()) expire(z); },
  });
  w.issueOrder(z, { type: 'attack', target: e.id });
  return z;
}

/** Tumba de Undying: invoca zombis junto a cada enemigo del radio. */
function tombstone(u: Unit, a: AbilityInst, x: number, y: number) {
  const w = u.w;
  const lvl = Math.max(1, Math.min(5, a.level));
  const tomb = w.spawnSummon(u, 'unit_tombstone' + lvl, x, y, dur(a, 'duration'), { kind: 'ward', hp: val(a, 'tombstone_health') });
  tomb.addMod({
    name: 'tombstone', persistent: true, fx: 'tombstone', states: ST.magicImmune, interval: val(a, 'zombie_interval'),
    // Solo los ataques la rompen: 4 de vida por golpe de héroe, 2 por el resto.
    onIncomingDamage(_m, ev) {
      if (!ev.isAttack) { ev.amount = 0; return; }
      ev.amount = (ev.source as Unit)?.isHeroLike ? 4 : 2;
    },
    onInterval() {
      if (!tomb.alive) return;
      for (const e of w.enemiesIn(u.team, tomb.x, tomb.y, val(a, 'radius'))) {
        if (!isUnitLike(e) || !w.canSee(u.team, e)) continue;
        zombie(u, a, e, Infinity, () => tomb.alive);
      }
    },
  });
  w.emit({ n: 'tombstone', x: tomb.x, y: tomb.y, r: val(a, 'radius'), t: u.team });
  return tomb;
}

defineAbility({
  key: 'undying_tombstone', target: 'unitOrPoint', team: 'any', allowSelf: true, reflectable: false, ai: { role: 'summon' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const al = t.unit && t.unit.team === u.team && t.unit.kind === 'hero' && hasShard(u) ? (t.unit as Unit) : null;
    const tomb = tombstone(u, a, t.unit ? t.unit.x : t.x, t.unit ? t.unit.y : t.y);
    if (!al) return;
    // Shard: el aliado se refugia dentro de la tumba.
    const since = w.time;
    al.order = null; al.atk.phase = 0;
    if (al.cast) w.interruptCast(al, true);
    al.addMod({
      name: 'tombstone_bunker', duration: dur(a, 'duration'), fx: 'tombstone_bunker',
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.noCollision,
      onTick(m) {
        if (tomb.alive) { al.x = tomb.x; al.y = tomb.y; return; }
        al.removeMod(m);
        stun(u, al, val(a, 'tombstone_stun_penalty'), a);
      },
      onOrder(m, o) {
        if (w.time - since >= val(a, 'tombstone_bunker_cd') && (o.type === 'move' || o.type === 'attackMove' || o.type === 'attack')) al.removeMod(m);
      },
      onDestroy() { w.forceMove(al, al.x + 60, al.y); },
    }, u, a);
  },
});

defineAbility({
  key: 'undying_ceaseless_dirge', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'ceaseless_dirge',
    onDeath(m) {
      const u = m.owner as Unit;
      const w = u.w;
      // Talento: deja una tumba al morir.
      const tb = ability(u, 'undying_tombstone');
      if (hasTalent(u, 'special_bonus_unique_undying_3') && tb && tb.level > 0) tombstone(u, tb, u.x, u.y);
      // Vuelve al poco de morir, con un enfriamiento largo.
      if (a.cd > 0 || u.kind !== 'hero') return;
      a.cd = val(a, '_cd');
      w.after(0, () => { if (!u.alive) u.respawnAt = Math.min(u.respawnAt, w.time + val(a, 'respawn_delay')); });
    },
  }),
});

defineAbility({
  key: 'undying_flesh_golem', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const tb = ability(u, 'undying_tombstone');
    u.addMod({
      name: 'flesh_golem', duration: dur(a, 'duration'), fx: 'flesh_golem',
      props: () => ({ str: u.baseAttr('str') * val(a, 'str_percentage') / 100, msPct: val(a, 'movement_bonus') / 100 }),
      onAttackLanded(_m, ev) {
        if (ev.fake) return;
        const t = ev.target as Unit;
        if (t.team === u.team || !isUnitLike(t)) return;
        debuff(u, t, a, { name: 'flesh_golem_plague', duration: val(a, 'slow_duration'), fx: 'flesh_golem_plague',
          props: { msSlow: val(a, 'slow') / 100, incomingPct: val(a, 'damage_amp') / 100 } });
        if (val(a, 'spawn_zombie_on_attack') > 0 && tb && tb.level > 0 && u.kind === 'hero') {
          zombie(u, tb, t, val(a, 'zombie_duration'), () => true);
        }
      },
    }, u, a);
  },
});

// Habilidad de los zombis: ralentizan al golpear y se enfurecen con objetivos heridos.
defineAbility({
  key: 'undying_tombstone_zombie_deathstrike', target: 'passive',
  passive: (a) => ({
    name: 'deathstrike',
    onAttackLanded(_m, ev) {
      const z = ev.attacker as Unit, t = ev.target as Unit;
      const cur = t.findMod('deathstrike_slow');
      const m = debuff(z, t, a, { name: 'deathstrike_slow', duration: val(a, 'duration'), fx: 'slow',
        props: (mm) => ({ msSlow: Math.abs(val(a, 'slow')) / 100 * mm.stacks }) });
      if (m) { m.stacks = Math.min(10, (cur?.stacks ?? 0) + 1); m.remaining = val(a, 'duration'); t.refreshStats(); }
      if (t.hp / t.s.maxHp * 100 < val(a, 'health_threshold_pct')) {
        z.addMod({ name: 'deathlust', duration: val(a, 'duration'), fx: 'haste',
          props: { msFlat: val(a, 'bonus_move_speed'), attackSpeed: val(a, 'bonus_attack_speed') } }, z, a);
      }
    },
  }),
});

defineHero('undying', ['undying_decay', 'undying_soul_rip', 'undying_tombstone', 'undying_ceaseless_dirge', 'undying_flesh_golem'], {
  build: ['phase_boots', 'magic_wand', 'vladmir', 'pipe', 'holy_locket', 'ultimate_scepter', 'shivas_guard'],
});
