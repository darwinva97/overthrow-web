import { ABILITIES, UNITS, lv } from '../data';
import { available, defineAbility, defineHero, dmg, dur, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { debuff, push, root, slow, stun } from './util';
import { controlledBy, dist, segDist, summonBrain } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
/** Valor de un talento que no está enlazado a ninguna habilidad. */
const talentVal = (key: string, k: string) => lv(ABILITIES[key]?.values[k], 1);

function unitBase(key: string, over: Partial<BaseStats>): BaseStats {
  const d = UNITS[key];
  return {
    hp: d.hp, hpRegen: d.hpRegen, mana: d.mana, manaRegen: d.manaRegen, armor: d.armor, mr: d.mr,
    dmgMin: d.dmgMin, dmgMax: d.dmgMax, bat: d.bat, attackPoint: d.attackPoint, range: d.range, projSpeed: d.projSpeed,
    ms: d.ms, dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: d.melee, ...over,
  };
}

// ---------------- Wild Axes ----------------

/** Pila de Wild Axes: más daño recibido de Beastmaster y sus unidades. */
function axeStack(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  const cur = e.findMod('wild_axes', u);
  const m = debuff(u, e, a, {
    name: 'wild_axes', duration: val(a, 'duration'), stacks: (cur?.stacks ?? 0) + 1, fx: 'slow',
    onIncomingDamage(mm, ev) {
      if (ev.source && controlledBy(ev.source as Unit, u)) ev.amount *= 1 + mm.stacks * val(a, 'damage_amp') / 100;
    },
  });
  if (m) { m.stacks = (cur?.stacks ?? 0) + 1; m.remaining = val(a, 'duration'); }
}

defineAbility({
  key: 'beastmaster_wild_axes', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  // Shard: sus ataques a héroes aplican también la pila.
  passive: (a) => ({
    name: 'wild_axes_shard',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (val(a, 'apply_debuff_on_attack') > 0 && hasShard(a.owner as Unit) && t.isHeroLike && t.team !== ev.attacker.team && !ev.missed) axeStack(a, t);
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ox = u.x, oy = u.y;
    const len = Math.min(val(a, 'range'), Math.max(1, Math.hypot(t.x - ox, t.y - oy)));
    const tx = ox + (t.x - ox) / Math.max(1, Math.hypot(t.x - ox, t.y - oy)) * len;
    const ty = oy + (t.y - oy) / Math.max(1, Math.hypot(t.x - ox, t.y - oy)) * len;
    const out = Math.max(val(a, 'min_throw_duration'), Math.min(val(a, 'max_throw_duration'), len / val(a, 'range') * val(a, 'max_throw_duration')));
    const nx = -(ty - oy) / len, ny = (tx - ox) / len;
    const half = val(a, 'spread') / 2;
    const r = val(a, 'radius');
    const hits = [new Set<number>(), new Set<number>()];
    let time = 0;
    u.addMod({
      name: 'wild_axes_flight', duration: out * 2 + 0.1, data: { multi: true },
      onTick(m, dt) {
        time += dt;
        const back = time > out;
        const s = Math.min(1, back ? (time - out) / out : time / out);
        [1, -1].forEach((sign, i) => {
          // Ida en curva hacia el punto y vuelta en curva hacia Beastmaster.
          const fx = back ? tx : ox, fy = back ? ty : oy;
          const gx = back ? u.x : tx, gy = back ? u.y : ty;
          const bend = Math.sin(Math.PI * s) * half * sign * (back ? -1 : 1);
          const x = fx + (gx - fx) * s + nx * bend, y = fy + (gy - fy) * s + ny * bend;
          if (u.w.tickN % 3 === 0) u.w.cutTrees(x, y, r * 0.5);
          for (const e of u.w.enemiesIn(u.team, x, y, r)) {
            if (hits[i].has(e.id)) continue;
            hits[i].add(e.id);
            damage(u, e, dmg(a, 'axe_damage'), 'magical', a);
            if (e.alive) axeStack(a, e);
          }
          if (u.w.tickN % 2 === 0) u.w.emit({ n: 'wild_axe', x, y, r: 40, t: u.team });
        });
        if (time >= out * 2) m.remaining = 0.001;
      },
    }, u, a);
  },
});

// ---------------- Invocaciones ----------------

const mySummons = (u: Unit, tag: string) => u.w.list.filter((s) => s.alive && s.owner === u && s.data_a1tag === tag);

defineAbility({
  key: 'beastmaster_summon_razorback', target: 'none', ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    for (const old of mySummons(u, 'boar')) old.expireAt = u.w.time;
    const dmgv = val(a, 'boar_base_damage');
    const boar = u.w.spawnSummon(u, unitBase('beastmaster_boar', {
      hp: val(a, 'boar_base_max_health'), dmgMin: dmgv, dmgMax: dmgv, ms: val(a, 'boar_base_movespeed'),
    }), u.x + Math.cos(u.facing) * 120, u.y + Math.sin(u.facing) * 120, dur(a, 'duration'), {
      name: 'beastmaster_boar', abilities: ['beastmaster_boar_poison'], level: a.level, xp: val(a, 'boar_base_xp_bounty'),
    });
    boar.data_a1tag = 'boar';
    summonBrain(boar);
  },
});

defineAbility({
  key: 'beastmaster_boar_poison', target: 'passive',
  passive: (a) => ({
    name: 'boar_poison',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (ev.missed || t.team === ev.attacker.team) return;
      slow(ev.attacker as Unit, t, a, 'boar_poison', val(a, 'duration'), Math.abs(val(a, 'movement_speed')) / 100, Math.abs(val(a, 'attack_speed')));
    },
  }),
});

/** Halcón: vuela en círculos alrededor de Beastmaster y se lanza en picado contra enemigos. */
function hawkBrain(a: AbilityInst, h: Unit, phase: number) {
  const u = a.owner as Unit;
  h.addMod({
    name: 'hawk', persistent: true, states: ST.busy | ST.noCollision | ST.flying | ST.disarmed,
    props: { magicResist: val(a, 'hawk_base_magic_resist') / 100 },
    data: { ang: phase, next: u.w.time + 1, dive: 0 },
    onTick(m, dt) {
      const w = h.w;
      const speed = val(a, 'max_move_speed');
      if (m.data.dive) {
        const e = w.units.get(m.data.dive);
        if (!e || !e.alive || !w.targetable(e)) { m.data.dive = 0; return; }
        const d = dist(e, h);
        if (d > speed * dt + 30) { w.forceMove(h, h.x + (e.x - h.x) / d * speed * dt, h.y + (e.y - h.y) / d * speed * dt); return; }
        m.data.dive = 0;
        w.emit({ n: 'hit', x: e.x, y: e.y, u: e.id, u2: h.id });
        damage(h, e, dmg(a, 'dive_damage'), 'magical', a);
        root(u, e, val(a, 'dive_root_duration'), a, 'hawk_dive');
        m.data.next = w.time + val(a, 'hawk_base_attack_interval') / (h.s.as / 100);
        return;
      }
      if (!u.alive) return;
      m.data.ang += Math.PI * 2 / val(a, 'roaming_seconds_per_rotation') * dt;
      const R = val(a, 'roaming_radius');
      const gx = u.x + Math.cos(m.data.ang) * R, gy = u.y + Math.sin(m.data.ang) * R;
      const d = Math.hypot(gx - h.x, gy - h.y);
      const step = Math.max(val(a, 'min_move_speed'), Math.min(speed, d * 3)) * dt;
      if (d > 1) w.forceMove(h, h.x + (gx - h.x) / d * Math.min(step, d), h.y + (gy - h.y) / d * Math.min(step, d));
      if (w.time < m.data.next) return;
      // Prioriza héroes.
      const list = w.enemiesIn(h.team, h.x, h.y, val(a, 'attack_radius')).filter((e) => w.canSee(h.team, e) && e.kind !== 'ward');
      list.sort((x, y) => (Number(y.isHeroLike) - Number(x.isHeroLike)) || dist(x, h) - dist(y, h));
      if (list[0]) m.data.dive = list[0].id;
    },
  }, u, a);
}

defineAbility({
  key: 'beastmaster_summon_raptor', target: 'none', ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    for (const old of mySummons(u, 'hawk')) old.expireAt = u.w.time;
    const n = val(a, 'hawk_count');
    for (let i = 0; i < n; i++) {
      u.w.after(i * val(a, 'hawk_spawn_interval'), () => {
        if (!u.alive) return;
        const vision = val(a, 'hawk_base_vision_range');
        const h = u.w.spawnSummon(u, unitBase('beastmaster_hawk', { hp: val(a, 'hawk_base_max_health'), dayVision: vision, nightVision: vision }),
          u.x, u.y, dur(a, 'duration'), { name: 'beastmaster_hawk', abilities: [], bounty: val(a, 'hawk_base_gold_bounty'), xp: val(a, 'hawk_base_xp_bounty') });
        h.data_a1tag = 'hawk';
        hawkBrain(a, h, (Math.PI * 2 * i) / n);
      });
    }
  },
});

// ---------------- Inner Beast y Drums of Slom ----------------

/** Ataque de Beastmaster o de una unidad suya cercana: alimenta los tambores. */
function drumBeat(u: Unit, n: number) {
  const d = find(u, 'beastmaster_drums_of_slom');
  if (!d || d.level <= 0 || !available(d)) return;
  d.data.stacks = Math.min(val(d, 'max_stacks'), (d.data.stacks ?? 0) + n);
  d.data.lastAttack = u.w.time;
  d.data.decay = u.w.time + val(d, 'stack_decay_time');
}

defineAbility({
  key: 'beastmaster_inner_beast', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'inner_beast', interval: 0.25,
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.alive) return;
      const ms = hasTalent(u, 'special_bonus_unique_beastmaster_5') ? talentVal('special_bonus_unique_beastmaster_5', 'bonus_ms') : 0;
      const hp = hasTalent(u, 'special_bonus_unique_beastmaster_6') ? talentVal('special_bonus_unique_beastmaster_6', 'bonus_hp') : 0;
      for (const s of u.w.list) {
        if (!s.alive || !controlledBy(s, u) || dist(s, u) > val(a, 'radius')) continue;
        s.addMod({
          name: 'inner_beast_buff', duration: 0.5,
          // Los talentos de vida y velocidad son para él y sus invocaciones.
          props: { attackSpeed: val(a, 'bonus_attack_speed'), damage: val(a, 'bonus_damage'), msFlat: ms, hp },
          onAttackLanded(_mm, ev) { if (!ev.missed && ev.target.team !== u.team) drumBeat(u, 1); },
        }, u, a);
      }
    },
  }),
});

defineAbility({
  key: 'beastmaster_drums_of_slom', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'drums_of_slom',
    onTick(m) {
      const u = m.owner as Unit;
      const w = u.w;
      const st = a.data.stacks ?? 0;
      if (st <= 0) return;
      if (w.time >= (a.data.decay ?? 0)) { a.data.stacks = st - 1; a.data.decay = w.time + val(a, 'stack_decay_time'); }
      if (w.time < (a.data.next ?? 0)) return;
      const k = Math.min(1, st / val(a, 'max_stacks'));
      a.data.next = w.time + val(a, 'max_drum_hit_interval') - (val(a, 'max_drum_hit_interval') - val(a, 'min_drum_hit_interval')) * k;
      let healed = 0;
      w.emit({ n: 'nova', x: u.x, y: u.y, r: val(a, 'radius'), t: u.team });
      for (const e of w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
        const hero = e.isHeroLike;
        const done = damage(u, e, dmg(a, 'base_damage') * (hero ? 1 : val(a, 'creep_damage_pct') / 100), 'magical', a);
        healed += done * (hero ? val(a, 'heal_pct') : val(a, 'creep_heal_pct')) / 100;
      }
      if (healed > 0) for (const s of w.list) if (s.alive && controlledBy(s, u) && dist(s, u) <= val(a, 'aura_radius')) heal(s, healed, u, true);
    },
  }),
});

// ---------------- Primal Roar ----------------

defineAbility({
  key: 'beastmaster_primal_roar', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ox = u.x, oy = u.y;
    u.w.emit({ n: 'berserkers_call', x: e.x, y: e.y, r: 200, t: u.team });
    damage(u, e, dmg(a, 'damage'), 'magical', a);
    stun(u, e, dur(a, 'duration'), a);
    // Lo que hay en el camino es apartado, dañado y ralentizado.
    const r = val(a, 'damage_radius');
    const len = dist(u, e) || 1;
    const dx = (e.x - ox) / len, dy = (e.y - oy) / len;
    for (const v of u.w.enemiesIn(u.team, (ox + e.x) / 2, (oy + e.y) / 2, len / 2 + r)) {
      if (v === e || segDist(v.x, v.y, ox, oy, e.x, e.y) > r) continue;
      damage(u, v, dmg(a, 'side_damage'), 'magical', a);
      if (!v.alive) continue;
      const side = (v.x - ox) * -dy + (v.y - oy) * dx >= 0 ? 1 : -1;
      push(v, -dy * side, dx * side, val(a, 'push_distance'), val(a, 'push_duration'), u, a, 'primal_roar_push');
      slow(u, v, a, 'primal_roar_slow', val(a, 'slow_duration'), Math.abs(val(a, 'slow_movement_speed_pct')) / 100, Math.abs(val(a, 'slow_attack_speed_pct')));
    }
    for (const s of u.w.list) {
      if (s.alive && controlledBy(s, u)) s.addMod({ name: 'primal_roar_speed', duration: val(a, 'movement_speed_duration'), fx: 'haste', props: { msPct: val(a, 'movement_speed') / 100 } }, u, a);
    }
    const drums = find(u, 'beastmaster_drums_of_slom');
    if (drums) drumBeat(u, val(drums, 'primal_roar_stacks'));
  },
});

defineHero('beastmaster', ['beastmaster_wild_axes', 'beastmaster_summon_razorback', 'beastmaster_summon_raptor', 'beastmaster_inner_beast', 'beastmaster_drums_of_slom', 'beastmaster_primal_roar'], {
  build: ['bracer', 'boots', 'helm_of_the_dominator', 'blink', 'black_king_bar', 'assault', 'ultimate_scepter'],
});
