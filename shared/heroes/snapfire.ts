import { castRangeOf, defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, addStacks, allyTarget, idle, optCharges, refund } from './lib/a7';
import { castDir, debuff, slow, stun } from './util';

const GOBBLE = 'snapfire_gobble_up';
const KISSES = 'snapfire_mortimer_kisses';

defineAbility({
  key: 'snapfire_scatterblast', target: 'point', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const ox = u.x, oy = u.y;
    u.w.addProjectile({
      kind: 'linear', fx: 'scatterblast', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'blast_speed'), left: castRangeOf(a),
      width: val(a, 'blast_width_initial'), widthEnd: val(a, 'blast_width_end'),
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward') return;
        // A quemarropa: más daño y más duración.
        const close = Math.hypot(v.x - ox, v.y - oy) <= val(a, 'point_blank_range') || val(a, 'bonus_applies_at_long_range') > 0;
        const amount = dmg(a, 'damage') * (close ? 1 + val(a, 'point_blank_dmg_bonus_pct') / 100 : 1);
        damage(u, v, amount, 'magical', a);
        const d = val(a, 'debuff_duration') * (close ? 1 + val(a, 'point_blank_debuff_duration_pct') / 100 : 1);
        slow(u, v, a, 'scatterblast', d, val(a, 'movement_slow_pct') / 100, val(a, 'attack_slow_pct'));
      },
    });
  },
});

/** Escupitajo de fuego: impacto y charco que quema y ralentiza (Mortimer Kisses / Spit Out / Shard de la galleta). */
function glob(u: Unit, k: AbilityInst, x: number, y: number, impact: number, radius: number, stunD = 0) {
  u.w.emit({ n: 'mortimer_impact', x, y, r: radius, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, radius)) {
    damage(u, e, impact, 'magical', k);
    if (stunD > 0) stun(u, e, stunD, k);
  }
  const iv = val(k, 'burn_interval');
  u.w.addZone({
    fx: 'firespit', x, y, r: radius, team: u.team, interval: iv, duration: val(k, 'burn_ground_duration'),
    onInterval(z) {
      for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
        debuff(u, e, k, {
          name: 'firespit_burn', duration: val(k, 'burn_linger_duration'), fx: 'burn',
          props: { msSlow: val(k, 'move_slow_pct') / 100 },
        });
        damage(u, e, val(k, 'burn_damage') * iv * k.upg.dmg, 'magical', k, { noProc: true });
      }
    },
  });
}

defineAbility({
  key: 'snapfire_firesnap_cookie', target: 'unit', team: 'any', allowSelf: true, ai: { role: 'disable' },
  charges: (a) => optCharges(a, 'abilitycharges', 'abilitychargerestoretime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = allyTarget(a, t.unit as Unit);
    if (!e) return;
    const hop = () => {
      if (!e.alive) return;
      // Con Shard la galleta también cura.
      const hp = val(a, 'target_heal');
      if (hp > 0) heal(e, hp, u);
      if (e.cast) e.w.interruptCast(e, true);
      const dist = val(a, 'jump_horizontal_distance');
      const time = val(a, 'jump_duration');
      const dx = Math.cos(e.facing), dy = Math.sin(e.facing);
      e.addMod({
        name: 'firesnap_hop', duration: time, fx: 'hop', states: ST.busy | ST.noCollision | ST.flying,
        onTick(m, dt) { const v = m.owner as Unit; v.w.forceMove(v, v.x + dx * dist / time * dt, v.y + dy * dist / time * dt); },
        onDestroy(m) {
          const v = m.owner as Unit;
          if (!v.alive) return;
          const r = val(a, 'impact_radius');
          v.w.emit({ n: 'cookie_land', x: v.x, y: v.y, r, t: u.team });
          for (const en of u.w.enemiesIn(u.team, v.x, v.y, r)) {
            damage(u, en, dmg(a, 'impact_damage'), 'magical', a);
            stun(u, en, dur(a, 'impact_stun_duration'), a);
          }
          const k = abil(u, KISSES);
          if (hasShard(u) && k && k.level > 0) {
            glob(u, k, v.x, v.y, dmg(k, 'damage_per_impact') * val(a, 'shard_damage_multiplier_tooltip') / 100, val(k, 'impact_radius'));
          }
        },
      }, u, a);
    };
    if (e === u) u.w.after(val(a, 'self_cast_delay'), hop);
    else u.w.addProjectile({ kind: 'track', fx: 'firesnap_cookie', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), onHit: () => { hop(); return true; } });
  },
});

defineAbility({
  key: 'snapfire_lil_shredder', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'lil_shredder', duration: dur(a, 'abilityduration'), fx: 'lil_shredder', stacks: val(a, 'buffed_attacks'),
      // BAT 1 aproximado con velocidad de ataque (el motor no cambia el BAT).
      props: { attackSpeed: val(a, 'attack_speed_bonus'), attackRange: val(a, 'attack_range_bonus') },
      onAttackStart(m, ev) {
        if (ev.fake && !m.data.extra) return;
        ev.damage = dmg(a, 'damage') + ev.damage * val(a, 'damage_pct') / 100;
      },
      onAttackLanded(m, ev) {
        const t = ev.target as Unit;
        if (t.team !== u.team) {
          addStacks(t, u, a, {
            name: 'lil_shredder_armor', debuff: true, fx: 'armor_reduction',
            props: (mm) => ({ armor: -mm.stacks * val(a, 'armor_reduction_per_attack') }),
          }, val(a, 'armor_duration'));
        }
        if (ev.fake) return;
        // Talento: dispara también a objetivos extra.
        const extra = val(a, 'extra_targets');
        if (extra > 0) {
          m.data.extra = true;
          const others = u.w.enemiesIn(u.team, u.x, u.y, u.s.attackRange + 100).filter((x) => x !== t && x.kind !== 'ward').slice(0, extra);
          for (const o of others) launchAttack(u, o, true);
          m.data.extra = false;
        }
        m.stacks--;
        if (m.stacks <= 0) u.removeMod(m);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'snapfire_gobble_up', target: 'unit', team: 'any', ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ok = (x: Unit | undefined): x is Unit => !!x && x !== u && x.alive && (x.team === u.team ? x.isHeroLike || x.kind === 'creep' || x.kind === 'summon' : x.kind === 'creep');
    let e: Unit | undefined = t.unit as Unit;
    if (!ok(e)) {
      if (!u.isBot) { refund(a); return; }
      // Los bots se tragan lo que tengan a mano.
      e = u.w.unitsIn(u.x, u.y, 350, ok)[0];
      if (!e) { refund(a); idle(a, 5); return; }
    }
    const v = e;
    v.w.disjoint(v);
    if (v.cast) v.w.interruptCast(v, true);
    a.data.gobbled = v.id;
    v.addMod({
      name: 'gobbled', duration: val(a, 'max_time_in_belly'), fx: 'gobbled', purgable: false, debuff: v.team !== u.team,
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.stunned | ST.noCollision,
      onTick(m) { (m.owner as Unit).x = u.x; (m.owner as Unit).y = u.y; },
      onDestroy(m) {
        if (a.data.gobbled === (m.owner as Unit).id) a.data.gobbled = 0;
        const o = m.owner as Unit;
        if (o.alive) o.w.teleport(o, o.x, o.y);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'snapfire_spit_creep', target: 'point', ai: { role: 'nuke' },
  hidden: (a) => !abil(a.owner as Unit, GOBBLE)?.data.gobbled,
  aoe: (a) => val(a, 'impact_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const g = abil(u, GOBBLE);
    const v = g?.data.gobbled ? u.w.units.get(g.data.gobbled) : undefined;
    if (!v || !v.alive) { idle(a, 1); return; }
    g!.data.gobbled = 0;
    v.removeModsByName('gobbled');
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const time = Math.max(val(a, 'min_lob_travel_time'), Math.min(val(a, 'max_lob_travel_time'), d / val(a, 'projectile_speed')));
    const sx = u.x, sy = u.y;
    v.addMod({
      name: 'spit_out', duration: time, fx: 'hop', states: ST.busy | ST.noCollision | ST.flying | ST.invulnerable,
      onTick(m) {
        const k = 1 - m.remaining / m.duration;
        const o = m.owner as Unit;
        o.x = sx + (t.x - sx) * k; o.y = sy + (t.y - sy) * k;
      },
      onDestroy(m) {
        const o = m.owner as Unit;
        o.w.teleport(o, t.x, t.y);
        const k = abil(u, KISSES);
        const impact = k && k.level > 0 ? dmg(k, 'damage_per_impact') : 0;
        if (k && k.level > 0) glob(u, k, t.x, t.y, impact, val(a, 'impact_radius'), val(a, 'stun_duration'));
        else for (const e of u.w.enemiesIn(u.team, t.x, t.y, val(a, 'impact_radius'))) stun(u, e, val(a, 'stun_duration'), a);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'snapfire_mortimer_kisses', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'impact_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const n = val(a, 'projectile_count');
    const d = val(a, 'abilityduration');
    const every = d / n;
    const minR = val(a, 'min_range');
    // El punto de mira se puede mover con órdenes de movimiento/ataque durante la ráfaga.
    const aim = (x: number, y: number) => {
      const dd = Math.hypot(x - u.x, y - u.y);
      if (dd >= minR) return [x, y];
      const [dx, dy] = castDir(u, x, y);
      return [u.x + dx * minR, u.y + dy * minR];
    };
    let [tx, ty] = aim(t.x, t.y);
    let fired = 0;
    u.order = null;
    const fire = () => {
      fired++;
      const dist = Math.hypot(tx - u.x, ty - u.y);
      const time = Math.max(val(a, 'min_lob_travel_time'), Math.min(val(a, 'max_lob_travel_time'), dist / val(a, 'projectile_speed')));
      const x = tx + (u.w.rng() - 0.5) * 60, y = ty + (u.w.rng() - 0.5) * 60;
      u.w.emit({ n: 'mortimer_glob', x: u.x, y: u.y, x2: x, y2: y, d: time, u: u.id });
      u.w.addVision(u.team, x, y, val(a, 'projectile_vision'), time + 0.5);
      u.w.after(time, () => glob(u, a, x, y, dmg(a, 'damage_per_impact'), val(a, 'impact_radius')));
    };
    u.addMod({
      name: 'mortimer_kisses', duration: d + 0.05, fx: 'mortimer_kisses', interval: every,
      states: ST.rooted | ST.disarmed,
      onInterval() { if (fired < n) fire(); },
      onTick(m) { if (u.has(ST.stunned) || u.has(ST.hexed)) u.removeMod(m); },
      onOrder(_m, o) {
        if (o.type === 'move' || o.type === 'attackMove') [tx, ty] = aim(o.x, o.y);
        else if (o.type === 'attack') { const e = u.w.units.get(o.target); if (e) [tx, ty] = aim(e.x, e.y); }
      },
    }, u, a);
    fire();
  },
});

defineAbility({
  key: 'snapfire_boomstick', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'boomstick',
    aura: {
      radius: val(a, 'distance_threshold_max'), team: 'enemy',
      apply: (m) => ({
        name: 'boomstick_mark',
        onIncomingDamage(_x, ev) {
          const u = m.owner as Unit;
          if (ev.source !== u) return;
          const d = Math.hypot(ev.target.x - u.x, ev.target.y - u.y);
          const lo = val(a, 'distance_threshold_min'), hi = val(a, 'distance_threshold_max');
          if (d >= hi) return;
          const k = d <= lo ? 1 : 1 - (d - lo) / (hi - lo);
          ev.amount *= 1 + (val(a, 'damage_amp_min') + (val(a, 'damage_amp_max') - val(a, 'damage_amp_min')) * k) / 100;
        },
      }),
    },
  }),
});

defineHero('snapfire', [
  'snapfire_scatterblast', 'snapfire_firesnap_cookie', 'snapfire_lil_shredder', 'snapfire_gobble_up', 'snapfire_spit_creep',
  'snapfire_mortimer_kisses', 'snapfire_boomstick',
], {
  build: ['bracer', 'arcane_boots', 'blink', 'force_staff', 'ultimate_scepter', 'black_king_bar', 'shivas_guard', 'refresher'],
});
