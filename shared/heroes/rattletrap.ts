import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { burnMana, damage } from '../sim/combat';
import { removeItem } from '../sim/items';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, push, slow, stun } from './util';
import { abil, reveal, segDist } from './lib/a6';

/** Overclocking (Scepter) activo. */
const overclocked = (u: Unit) => !!u.findMod('overclocking');
function oc(u: Unit, key: string): number {
  const o = abil(u, 'rattletrap_overclocking');
  return o && o.level > 0 ? val(o, key) : 0;
}

defineAbility({
  key: 'rattletrap_battery_assault', target: 'none', ai: { role: 'aoe', selfRadius: 250 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const every = val(a, 'interval');
    const shot = () => {
      const all = overclocked(u);
      const r = all ? val(a, 'overclocking_radius') : val(a, 'radius');
      const list = u.w.enemiesIn(u.team, u.x, u.y, r, { immune: false });
      if (!list.length) return;
      // Prioriza héroes; con Overclocking golpea a todos.
      const heroes = list.filter((e) => e.isHeroLike);
      const pool = heroes.length ? heroes : list;
      const targets = all ? list : [pool[Math.floor(u.w.rng() * pool.length)]];
      for (const e of targets) {
        u.w.emit({ n: 'battery_assault', x: e.x, y: e.y, u: e.id, u2: u.id });
        damage(u, e, dmg(a, 'damage') * (e.kind === 'creep' ? val(a, 'creep_damage_multiplier') : 1), 'magical', a);
        stun(u, e, 0.1, a);
      }
    };
    u.addMod({
      name: 'battery_assault', duration: dur(a, 'duration'), fx: 'battery_assault', interval: every,
      onInterval: shot,
    }, u, a);
    shot();
  },
});

// ---------------- Power Cogs ----------------

interface Cog { unit: Unit; ang: number; spent: boolean }

defineAbility({
  key: 'rattletrap_power_cogs', target: 'none', ai: { role: 'disable', selfRadius: 200 },
  aoe: (a) => val(a, 'cogs_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const big = overclocked(u);
    const R = big ? val(a, 'cogs_radius_overclock') : val(a, 'cogs_radius');
    const trigger = big ? val(a, 'trigger_distance_overclock') : val(a, 'trigger_distance');
    const pushT = big ? val(a, 'push_duration_overclock') : val(a, 'push_duration');
    const d = dur(a, 'duration');
    const cx = u.x, cy = u.y;
    const n = 8;
    // Quién empieza dentro se queda dentro; quién está fuera, fuera.
    const inside = new Set(u.w.unitsIn(cx, cy, R - 10).map((x) => x.id));
    const cogs: Cog[] = [];
    for (let i = 0; i < n; i++) {
      const ang = i * 2 * Math.PI / n;
      const c = u.w.spawnSummon(u, 'rattletrap_cog', cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, d, {
        kind: 'ward', hp: val(a, 'attacks_to_destroy'),
      });
      c.x = cx + Math.cos(ang) * R; c.y = cy + Math.sin(ang) * R;
      c.addMod({
        name: 'power_cog', persistent: true, fx: 'power_cog', states: ST.rooted | ST.disarmed | ST.noCollision,
        onIncomingDamage(_m, ev) { ev.amount = ev.isAttack ? 1 : 0; },
      }, u, a);
      cogs.push({ unit: c, ang, spent: false });
    }
    u.w.emit({ n: 'power_cogs', x: cx, y: cy, r: R, d, t: u.team });
    const half = Math.PI / n;
    // La jaula: bloquea el paso por el anillo donde quede un engranaje vivo.
    const cage = u.addMod({
      name: 'power_cogs_cage', duration: d, persistent: true,
      props: () => {
        if (!overclocked(u) && val(a, 'bonus_armor') <= 0) return {};
        const near = Math.hypot(u.x - cx, u.y - cy) < R + 200;
        return near ? { armor: val(a, 'bonus_armor') + (overclocked(u) ? u.base.armor * oc(u, 'bonus_armor_pct') / 100 : 0) } : {};
      },
      onTick() {
        const alive = cogs.filter((c) => c.unit.alive);
        if (!alive.length) { cage.remaining = 0.001; return; }
        // Talento: inmunidad a debuffs dentro de los engranajes.
        if (val(a, 'debuff_immune_inside_cogs') > 0) {
          const inCage = Math.hypot(u.x - cx, u.y - cy) < R;
          if (inCage && !u.findMod('cogs_immunity')) u.addMod({ name: 'cogs_immunity', duration: 0.2, states: ST.magicImmune }, u, a);
          else if (inCage) u.findMod('cogs_immunity')!.remaining = 0.2;
        }
        for (const v of u.w.unitsIn(cx, cy, R + trigger + 40, (x) => x !== u && x.alive && (x.isHeroLike || x.kind === 'creep') && !x.has(ST.flying))) {
          const dx = v.x - cx, dy = v.y - cy;
          const dist = Math.hypot(dx, dy) || 1;
          const ang = Math.atan2(dy, dx);
          const cog = alive.find((c) => {
            let diff = Math.abs(ang - c.ang) % (Math.PI * 2);
            if (diff > Math.PI) diff = Math.PI * 2 - diff;
            return diff <= half + 0.05;
          });
          if (!cog) continue;
          const wasIn = inside.has(v.id);
          if (wasIn && dist > R - v.radius) {
            u.w.forceMove(v, cx + dx / dist * (R - v.radius), cy + dy / dist * (R - v.radius));
          } else if (!wasIn) {
            // Enemigo que toca un engranaje cargado: descarga.
            const cd = Math.hypot(v.x - cog.unit.x, v.y - cog.unit.y);
            if (v.team !== u.team && !cog.spent && cd <= trigger + v.radius && u.w.targetable(v)) {
              cog.spent = true;
              u.w.emit({ n: 'cog_shock', x: cog.unit.x, y: cog.unit.y, x2: v.x, y2: v.y, t: u.team });
              const burned = burnMana(v, val(a, 'mana_burn'));
              damage(u, v, dmg(a, 'damage') + burned * val(a, 'mana_burn_as_damage_pct') / 100, 'magical', a);
              if (v.alive) push(v, dx, dy, val(a, 'push_length'), pushT, u, a, 'cog_push');
            } else if (dist < R + v.radius) {
              u.w.forceMove(v, cx + dx / dist * (R + v.radius), cy + dy / dist * (R + v.radius));
            }
          }
        }
      },
      onDestroy() { for (const c of cogs) if (c.unit.alive) c.unit.expireAt = u.w.time; },
    }, u, a);
  },
});

// ---------------- Rocket Flare ----------------

function flareAt(a: AbilityInst, x: number, y: number, mult: number) {
  const u = a.owner as Unit;
  const delay = Math.hypot(x - u.x, y - u.y) / val(a, 'speed');
  u.w.emit({ n: 'rocket_flare', x: u.x, y: u.y, x2: x, y2: y, d: delay, t: u.team });
  u.w.after(delay, () => {
    const r = val(a, 'radius');
    const d = val(a, 'duration') * mult;
    u.w.emit({ n: 'rocket_flare_hit', x, y, r, t: u.team });
    u.w.addVision(u.team, x, y, r, d);
    for (const e of u.w.enemiesIn(u.team, x, y, r)) {
      damage(u, e, dmg(a, 'damage') * mult, 'magical', a);
      slow(u, e, a, 'rocket_flare_slow', val(a, 'slow_duration') * mult, val(a, 'slow_pct') / 100);
    }
    if (val(a, 'true_sight') > 0) {
      u.w.addZone({
        fx: 'rocket_flare_sight', x, y, r, team: u.team, interval: 0.2, duration: d,
        onInterval(z) { for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) if (e.has(ST.invisible)) reveal(u, e, 0.3, a, 'flare_reveal'); },
      });
    }
  });
}

defineAbility({
  key: 'rattletrap_rocket_flare', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  castRange: () => 99999,
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime') * a.upg.cd * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (!overclocked(u)) { flareAt(a, t.x, t.y, 1); return; }
    // Overclocking: más daño y dos cohetes extra a los lados.
    const mult = 1 + oc(u, 'rocket_flare_damage_pct') / 100;
    flareAt(a, t.x, t.y, mult);
    const [dx, dy] = castDir(u, t.x, t.y);
    const off = val(a, 'radius') * oc(u, 'rocket_flare_offset_pct') / 100;
    const every = oc(u, 'rocket_flare_interval');
    for (let i = 0; i < oc(u, 'rocket_flare_rockets'); i++) {
      const side = i % 2 ? 1 : -1;
      u.w.after(every * (i + 1), () => flareAt(a, t.x - dy * off * side, t.y + dx * off * side, mult));
    }
  },
});

// ---------------- Overclocking (Scepter) y Jetpack (Shard) ----------------

defineAbility({
  key: 'rattletrap_overclocking', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'overclocking', duration: val(a, 'buff_duration'), fx: 'overclocking', purgable: false,
      props: { msPct: val(a, 'bonus_movement_speed') / 100, attackSpeed: val(a, 'bonus_attack_speed') },
      onDestroy() {
        // Al acabar, Clockwerk queda casi parado ("a paso de tortuga": los datos no dan cifra).
        if (u.alive) u.addMod({ name: 'overclocking_crash', duration: val(a, 'debuff_duration'), debuff: true, purgable: false, fx: 'slow', props: { msSlow: 0.9, attackSlow: 400 } }, u, a);
      },
    }, u, a);
  },
});

function setJet(u: Unit, a: AbilityInst, on: boolean) {
  const m = u.findMod('jetpack');
  if (!m) return;
  m.data.on = on;
  m.states = on ? ST.flying | ST.noCollision | ST.disarmed : 0;
  u.refreshStats();
}

defineAbility({
  key: 'rattletrap_jetpack', target: 'none', ai: { role: 'escape', selfRadius: 300 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const toggle = abil(u, 'rattletrap_jetpack_toggle');
    u.removeModsByName('jetpack');
    u.addMod({
      name: 'jetpack', duration: val(a, 'duration'), fx: 'jetpack', purgable: true, data: { on: true },
      states: ST.flying | ST.noCollision | ST.disarmed,
      props: (m) => (m.data.on ? { msPct: (val(a, 'bonus_speed') + (overclocked(u) ? oc(u, 'jetpack_bonus_speed') : 0)) / 100 } : {}),
      onDestroy() {
        if (toggle) { toggle.toggled = false; }
        if (!u.w.grid.walkable(u.x, u.y)) u.w.teleport(u, u.x, u.y);
      },
    }, u, a);
    if (toggle) toggle.toggled = true;
  },
});

defineAbility({
  key: 'rattletrap_jetpack_toggle', target: 'toggle', levelWith: 4,
  hidden: (a) => !(a.owner as Unit).findMod('jetpack'),
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!u.findMod('jetpack')) { a.toggled = false; return; }
    setJet(u, a, on);
    if (!on && !u.w.grid.walkable(u.x, u.y)) u.w.teleport(u, u.x, u.y);
  },
});

// ---------------- Hookshot ----------------

defineAbility({
  key: 'rattletrap_hookshot', target: 'point', ult: true, castBeyond: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const big = overclocked(u);
    const radius = val(a, 'stun_radius') * (big ? 1 + oc(u, 'hookshot_radius_bonus_pct') / 100 : 1);
    const stunDur = dur(a, 'duration') * (big ? 1 + oc(u, 'hookshot_duration_bonus_pct') / 100 : 1);
    const range = Math.min(Math.hypot(t.x - u.x, t.y - u.y) + 200, val(a, 'abilitycastrange') * a.upg.range + u.s.castRange);
    const speed = val(a, 'speed');
    const strike = (e: Unit) => {
      if (e.team === u.team) return;
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      const m = stun(u, e, stunDur, a);
      if (m) m.data.strongPurgable = true;
    };
    u.w.addProjectile({
      kind: 'linear', fx: 'hookshot', source: u, x: u.x, y: u.y, dx, dy, speed, left: range,
      width: val(a, 'latch_radius') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.kind === 'ward' || !(v.isHeroLike || v.kind === 'creep' || v.kind === 'summon')) return false;
        if (v.team !== u.team && v.has(ST.magicImmune) && !a.def.bkbPierce) return false;
        const hit = new Set<number>([v.id]);
        const x0 = u.x, y0 = u.y;
        // Clockwerk sale disparado hacia lo que enganchó, golpeando por el camino.
        dash(u, v.x - dx * (u.radius + v.radius), v.y - dy * (u.radius + v.radius), speed, a, {
          name: 'hookshot_pull', states: ST.magicImmune,
          onStep: (w) => {
            for (const e2 of w.w.enemiesIn(w.team, w.x, w.y, radius)) {
              if (hit.has(e2.id)) continue;
              const s = segDist(e2.x, e2.y, x0, y0, dx, dy, Math.hypot(w.x - x0, w.y - y0));
              if (s.d > radius) continue;
              hit.add(e2.id);
              strike(e2);
            }
          },
          onArrive: (w) => {
            u.w.emit({ n: 'hookshot_impact', x: v.x, y: v.y, r: radius, t: u.team });
            strike(v);
            for (const e2 of w.w.enemiesIn(w.team, v.x, v.y, radius)) if (e2 !== v) strike(e2);
          },
        });
        return true;
      },
    });
  },
});

// ---------------- Armor Power (innata) ----------------

defineAbility({
  key: 'rattletrap_armor_power', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'armor_power', interval: 0.5, data: { eaten: a.data.eaten ?? 0 },
    props: (m) => ({
      armor: m.data.eaten * val(a, 'armor_per_chainmail'),
      outgoingPct: Math.max(0, (m.owner as Unit).s?.armor ?? 0) * val(a, 'damage_per_armor') / 100,
    }),
    onInterval(m) {
      const u = m.owner as Unit;
      // Se come las Chainmail que lleve en la mochila (el "autolanzamiento" de Dota).
      if (u.kind === 'hero' && val(a, 'can_consume_chainmail') > 0) {
        for (const s of [6, 7, 8]) {
          const it = u.items[s];
          if (it?.key !== 'chainmail') continue;
          removeItem(u, it);
          a.data.eaten = m.data.eaten = (m.data.eaten ?? 0) + 1;
        }
      }
      u.refreshStats();
    },
  }),
});

defineHero('rattletrap', ['rattletrap_battery_assault', 'rattletrap_power_cogs', 'rattletrap_rocket_flare', 'rattletrap_overclocking', 'rattletrap_jetpack', 'rattletrap_hookshot', 'rattletrap_armor_power', 'rattletrap_jetpack_toggle'], {
  build: ['bracer', 'phase_boots', 'blade_mail', 'pipe', 'black_king_bar', 'ultimate_scepter', 'assault', 'shivas_guard'],
});
