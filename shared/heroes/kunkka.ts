import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasTalent, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import { armorMult, type Unit } from '../sim/unit';
import { botBrain, inTrapezoid } from './lib/a4';
import { castDir, debuff, push, slow, stun } from './util';

/** Talento +100 de área de hechizos. */
const aoeBonus = (u: Unit) => (hasTalent(u, 'special_bonus_spell_aoe_100') ? 100 : 0);
const rumOf = (u: Unit) => u.abilities.find((x) => x.key === 'kunkka_admirals_rum');

/**
 * Trago de Admiral's Rum: más velocidad y retrasa un % del daño recibido, que se sufre después
 * repartido durante el mismo tiempo.
 */
function drinkRum(u: Unit, by: Unit, a: AbilityInst | null, absorbPct: number, msPct: number, duration: number, name = 'admirals_rum') {
  u.addMod({
    name, duration, fx: 'rum', data: { stored: 0 },
    props: { msPct: msPct / 100 },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || ev.amount <= 0) return;
      const cut = ev.amount * absorbPct / 100;
      ev.amount -= cut;
      m.data.stored += cut;
    },
    onDestroy(m) {
      const total = m.data.stored as number;
      if (total < 1 || !u.alive) return;
      const ticks = Math.max(1, Math.round(duration));
      u.addMod({
        name: name + '_hangover', duration: ticks + 0.05, interval: 1, data: { multi: true },
        onInterval() { damage(by, u, total / ticks, 'pure', a, { hpRemoval: true, noProc: true }); },
      }, by, a);
    },
  }, by, a);
}

defineAbility({
  key: 'kunkka_torrent', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius') + aoeBonus(a.owner as Unit),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius') + aoeBonus(u);
    const delay = val(a, 'delay');
    u.w.emit({ n: 'torrent_bubbles', x: t.x, y: t.y, r, d: delay, t: u.team });
    u.w.addVision(u.team, t.x, t.y, r, delay + 1, true);
    u.w.after(delay, () => {
      u.w.emit({ n: 'torrent', x: t.x, y: t.y, r, t: u.team });
      const st = val(a, 'stun_duration');
      const tick = val(a, 'damage_tick_interval');
      const total = dmg(a, 'torrent_damage');
      const instant = total * val(a, 'percent_instant') / 100;
      const ticks = Math.max(1, Math.round(st / tick));
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        if (instant > 0) damage(u, e, instant, 'magical', a);
        stun(u, e, st, a);
        debuff(u, e, a, {
          name: 'torrent_dmg', duration: st + 0.01, interval: tick,
          onInterval(m) { damage(u, m.owner as Unit, (total - instant) / ticks, 'magical', a); },
        });
        slow(u, e, a, 'torrent_slow', st + dur(a, 'slow_duration'), Math.abs(val(a, 'movespeed_bonus')) / 100);
      }
    });
  },
});

/** Tidebringer listo: con el talento de cargas se gestionan aquí. */
function tideReady(a: AbilityInst) {
  const u = a.owner as Unit;
  if (hasTalent(u, 'special_bonus_unique_kunkka_tidebringer_charges')) return (a.data.ch ?? val(a, 'abilitycharges')) > 0;
  return a.cd <= 0;
}

defineAbility({
  key: 'kunkka_tidebringer', target: 'toggle', ai: { role: 'buff' },
  onLevelUp(a) { if (a.level === 1) a.toggled = true; },
  passive: (a) => ({
    name: 'tidebringer',
    onTick(m, dt) {
      const u = m.owner as Unit;
      if (!hasTalent(u, 'special_bonus_unique_kunkka_tidebringer_charges')) return;
      const max = val(a, 'abilitycharges');
      a.data.ch ??= max;
      if (a.data.ch >= max) { a.data.rt = 0; return; }
      a.data.rt = (a.data.rt ?? 0) + dt;
      if (a.data.rt >= val(a, 'abilitychargerestoretime')) { a.data.rt = 0; a.data.ch++; }
    },
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (!a.toggled || ev.fake || t.team === u.team || !tideReady(a) || u.kind !== 'hero' && u.kind !== 'illusion') return;
      if (t.kind === 'ward' || t.kind === 'fountain') return;
      ev.damage += val(a, 'damage_bonus');
      a.data.pending = ev;
      if (hasTalent(u, 'special_bonus_unique_kunkka_tidebringer_charges')) a.data.ch = (a.data.ch ?? 1) - 1;
      else a.cd = cooldownOf(a);
      const pierce = val(a, 'pierces_armor');
      if (pierce > 0 && t.s.armor > 0) {
        t.addMod({ name: 'tidebringer_pierce', duration: 0.05, debuff: true, props: { armor: -t.s.armor * pierce / 100 } }, u, a);
      }
    },
    onAttackLanded(_m, ev) {
      if (a.data.pending !== ev) return;
      a.data.pending = null;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      u.w.emit({ n: 'tidebringer', x: u.x, y: u.y, x2: t.x, y2: t.y, u: u.id });
      const [dx, dy] = [t.x - u.x, t.y - u.y];
      const sw = val(a, 'cleave_starting_width'), ew = val(a, 'cleave_ending_width'), dist = val(a, 'cleave_distance');
      // El barrido ignora la armadura de los alcanzados: parte del daño ya reducido por la del objetivo.
      const amount = ev.damage * ev.critMult * val(a, 'cleave_damage') / 100 * armorMult(t.s.armor);
      const slowPct = Math.abs(val(a, 'movespeed_slow')) / 100;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, dist + 50, { immune: true })) {
        if (e === t || e.kind === 'ward') continue;
        if (!inTrapezoid(u.x, u.y, dx, dy, e.x, e.y, sw, ew, dist)) continue;
        damage(u, e, amount, 'pure', null, { noProc: true });
        if (slowPct > 0) slow(u, e, a, 'tidebringer_slow', val(a, 'movespeed_slow_duration'), slowPct);
      }
      if (slowPct > 0) slow(u, t, a, 'tidebringer_slow', val(a, 'movespeed_slow_duration'), slowPct);
    },
  }),
});

/** Devuelve a las unidades marcadas por X a su sitio. */
function returnMarks(a: AbilityInst) {
  const u = a.owner as Unit;
  const marks = (a.data.marks ?? []) as { id: number; x: number; y: number; until: number }[];
  for (const mk of marks) {
    const t = u.w.units.get(mk.id);
    if (!t || !t.alive) continue;
    u.w.emit({ n: 'blink', x: t.x, y: t.y, x2: mk.x, y2: mk.y, u: t.id, c: 'xmark' });
    t.removeModsByName('x_marks_the_spot');
    u.w.teleport(t, mk.x, mk.y);
    t.order = null;
  }
  a.data.marks = [];
}

defineAbility({
  key: 'kunkka_x_marks_the_spot', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e.isHeroLike) return;
    const ally = e.team === u.team;
    const d = ally ? val(a, 'allied_duration') : val(a, 'duration');
    const mark = { id: e.id, x: e.x, y: e.y, until: u.w.time + d };
    a.data.marks = [...(a.data.marks ?? []).filter((m: any) => m.id !== e.id && m.until > u.w.time), mark];
    u.w.addVision(u.team, e.x, e.y, val(a, 'fow_range'), val(a, 'fow_duration'), true);
    u.w.emit({ n: 'x_mark', x: e.x, y: e.y, d, t: u.team });
    const spec = {
      name: 'x_marks_the_spot', duration: d, fx: 'x_mark', purgable: false,
      onDestroy() {
        if (!(a.data.marks ?? []).some((m: any) => m.id === e.id)) return;
        a.data.marks = (a.data.marks ?? []).filter((m: any) => m.id !== e.id);
        if (!e.alive) return;
        u.w.teleport(e, mark.x, mark.y);
        e.order = null;
      },
    };
    if (ally) {
      e.addMod(spec, u, a);
      drinkRum(e, u, a, val(a, 'ghostship_absorb'), val(a, 'movespeed_bonus'), d, 'x_marks_rum');
    } else debuff(u, e, a, { ...spec, purgable: false });
  },
});

defineAbility({
  key: 'kunkka_admirals_rum', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'admirals_rum_watch',
    onTakeDamage(m, ev) {
      const u = m.owner as Unit;
      if (a.cd > 0 || ev.amount < val(a, 'damage_threshold') || ev.source === u || !u.alive || u.kind !== 'hero') return;
      a.cd = cooldownOf(a);
      drinkRum(u, u, a, val(a, 'ghostship_absorb'), val(a, 'movespeed_bonus'), val(a, 'buff_duration'));
    },
  }),
});

defineAbility({
  key: 'kunkka_tidal_wave', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const width = val(a, 'radius') + aoeBonus(u);
    const speed = val(a, 'speed');
    const back = 300;
    u.w.addProjectile({
      kind: 'linear', fx: 'tidal_wave', source: u, x: u.x - dx * back, y: u.y - dy * back, dx, dy,
      speed, left: val(a, 'wave_distance_tooltip'), width,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || !u.w.targetable(v) || v.has(ST.magicImmune)) return false;
        damage(u, v, dmg(a, 'damage'), 'magical', a);
        if (v.alive) {
          const kd = val(a, 'knockback_distance');
          if (v.cast) u.w.interruptCast(v, true);
          push(v, dx, dy, kd, Math.min(val(a, 'duration'), kd / speed), u, a, 'tidal_wave_drag');
        }
        return false;
      },
    });
  },
});

/** Un barco de Ghostship: navega hasta `cx,cy` y revienta allí. */
function sailShip(a: AbilityInst, cx: number, cy: number, dx: number, dy: number) {
  const u = a.owner as Unit;
  const dist = val(a, 'ghostship_distance');
  const width = val(a, 'ghostship_width') + aoeBonus(u);
  const speed = val(a, 'ghostship_speed');
  const rum = rumOf(u);
  const factor = val(a, 'rum_factor');
  const cannons = hasScepter(u) && val(a, 'fire_cannons') > 0;
  let volleys = 0, cannonT = 0;
  u.w.addProjectile({
    kind: 'linear', fx: 'ghostship', source: u, x: cx - dx * dist, y: cy - dy * dist, dx, dy,
    speed, left: dist, width,
    onHit(_p, e) {
      const v = e as Unit;
      if (v.team === u.team && v.isHeroLike && rum) {
        drinkRum(v, u, a, val(rum, 'ghostship_absorb') * factor, val(rum, 'movespeed_bonus') * factor, val(rum, 'buff_duration'), 'ghostship_rum');
      }
      return false;
    },
    onThink(p, dt) {
      if (!cannons || volleys >= val(a, 'num_cannon_volleys')) return;
      cannonT += dt;
      if (cannonT < val(a, 'cannon_fire_interval')) return;
      cannonT = 0;
      volleys++;
      const n = val(a, 'cannon_count');
      for (const side of [-1, 1]) for (let i = 0; i < n; i++) {
        // Balas a babor y estribor, abiertas en abanico.
        const ang = Math.atan2(dy, dx) + side * (Math.PI / 2 - (val(a, 'base_cannon_rotation') + i * val(a, 'rotation_per_cannon')) * Math.PI / 180 * 0.5);
        const off = val(a, 'initial_cannon_offset') + i * val(a, 'distance_between_cannons');
        u.w.addProjectile({
          kind: 'linear', fx: 'cannon_ball', source: u, x: p.x + dx * off, y: p.y + dy * off,
          dx: Math.cos(ang), dy: Math.sin(ang), speed: val(a, 'cannon_ball_speed'),
          left: val(a, 'cannon_ball_distance'), width: val(a, 'cannon_ball_radius') * 2,
          onHit(_q, e) {
            const v = e as Unit;
            if (v.team === u.team || v.kind === 'ward' || v.has(ST.magicImmune)) return false;
            damage(u, v, dmg(a, 'abilitydamage') * val(a, 'cannon_ball_damage_pct') / 100, 'magical', a);
            return false;
          },
        });
      }
    },
    onEnd() {
      u.w.emit({ n: 'ghostship_crash', x: cx, y: cy, r: width / 2, t: u.team });
      for (const e of u.w.enemiesIn(u.team, cx, cy, width / 2)) {
        damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
        stun(u, e, dur(a, 'stun_duration'), a);
      }
    },
  });
}

defineAbility({
  key: 'kunkka_ghostship', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => (val(a, 'ghostship_width') + aoeBonus(a.owner as Unit)) / 2,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const r = Math.min(Math.hypot(t.x - u.x, t.y - u.y), val(a, 'abilitycastrange') + u.s.castRange) || val(a, 'abilitycastrange');
    const cx = u.x + dx * r, cy = u.y + dy * r;
    sailShip(a, cx, cy, dx, dy);
    if (hasScepter(u)) {
      const n = val(a, 'fleet_count');
      for (let i = 1; i < n; i++) u.w.after(val(a, 'fleet_interval') * i, () => sailShip(a, cx, cy, dx, dy));
    }
  },
});

defineAbility({
  key: 'kunkka_return', target: 'none', levelWith: 2,
  hidden: (a) => !(a.owner.abilities[2]?.data.marks ?? []).some((m: any) => m.until > a.owner.w.time),
  // El bot recoge la marca cuando el marcado se ha alejado del sitio.
  passive: (a) => botBrain(a, (u) => {
    const x = u.abilities[2];
    for (const mk of (x?.data.marks ?? []) as { id: number; x: number; y: number; until: number }[]) {
      const t = u.w.units.get(mk.id);
      if (!t || !t.alive || t.team === u.team) continue;
      if (Math.hypot(t.x - mk.x, t.y - mk.y) > 350 && mk.until - u.w.time < val(x!, 'duration') - 1) return { x: u.x, y: u.y };
    }
    return null;
  }),
  onSpellStart(a) { const x = (a.owner as Unit).abilities[2]; if (x) returnMarks(x); },
});

defineHero('kunkka', [
  'kunkka_torrent', 'kunkka_tidebringer', 'kunkka_x_marks_the_spot', 'kunkka_admirals_rum',
  'kunkka_tidal_wave', 'kunkka_ghostship', 'kunkka_return',
], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'greater_crit', 'assault', 'ultimate_scepter'],
  upgrades: [
    { slot: 0, key: 'torrent_damage', amount: 40, max: 5, label: 'Torrent: +40 daño' },
    { slot: 0, key: 'radius', amount: 25, max: 4, label: 'Torrent: +25 radio' },
    { slot: 1, key: 'damage_bonus', amount: 25, max: 5, label: 'Tidebringer: +25 daño' },
    { slot: 1, key: '_cd', amount: -8, pct: true, max: 5, label: 'Tidebringer: −8% enfriamiento' },
    { slot: 2, key: '_cd', amount: -8, pct: true, max: 4, label: 'X Marks the Spot: −8% enfriamiento' },
    { slot: 5, key: 'abilitydamage', amount: 75, max: 5, label: 'Ghostship: +75 daño' },
    { slot: 5, key: '_cd', amount: -8, pct: true, max: 4, label: 'Ghostship: −8% enfriamiento' },
  ],
});
