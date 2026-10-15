import { UNITS } from '../data';
import { defineAbility, defineHero, dur, val } from '../sim/abilities';
import { dealDamage, heal, landAttack, launchAttack, makeAttack } from '../sim/combat';
import type { AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import { armorMult, type Unit } from '../sim/unit';
import { castDir } from './util';
import { aiBy, botCast, heroOf } from './lib/a2';

const isArcher = (u: Unit) => !!u.data_archer;
const archersOf = (u: Unit) => u.w.list.filter((c) => c.alive && c.owner === u && isArcher(c));
const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);

/** Infernal Shred: perforación de armadura acumulada en el objetivo. */
function shred(src: Unit, ev: AttackEvent) {
  const clinkz = heroOf(src);
  const inn = clinkz.abilities.find((x) => x.key === 'clinkz_infernal_shred');
  const t = ev.target as Unit;
  if (!inn || t.team === src.team || !t.alive) return;
  const m = t.findMod('infernal_shred', clinkz);
  const pct = Math.min(val(inn, 'max_armor_piercing_pct'), m ? m.stacks : 0);
  if (pct > 0 && t.s.armor > 0) {
    // El ataque ignora parte de la armadura: se compensa en el daño.
    ev.damage *= armorMult(t.s.armor * (1 - pct / 100)) / armorMult(t.s.armor);
  }
  const add = src.kind === 'hero' ? val(inn, 'hero_stacks') : val(inn, 'skeleton_stacks');
  const mm = t.addMod({ name: 'infernal_shred', duration: val(inn, 'duration'), debuff: true, purgable: true, fx: 'shred' }, clinkz, inn);
  mm.stacks = Math.min(val(inn, 'max_armor_piercing_pct'), (m ? m.stacks : 0) + add);
  mm.remaining = val(inn, 'duration');
}

/** Crea los Skeleton Archers (inmóviles, mueren a golpes). */
function spawnArchers(clinkz: Unit, points: [number, number][], duration: number) {
  const ww = abil(clinkz, 'clinkz_wind_walk');
  const sa = abil(clinkz, 'clinkz_searing_arrows');
  const pctDmg = ww ? val(ww, 'damage_percent') / 100 : 0.2;
  const avg = (clinkz.s.dmgMin + clinkz.s.dmgMax) / 2 + clinkz.s.dmgBonus;
  const d = UNITS.clinkz_skeleton_archer;
  const hits = ww ? val(ww, 'skeleton_health') : 8;
  for (const [x, y] of points) {
    const s = clinkz.w.spawnSummon(clinkz, {
      hp: hits, hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0,
      dmgMin: avg * pctDmg, dmgMax: avg * pctDmg, bat: ww ? val(ww, 'attack_rate') : 1.6, attackPoint: d?.attackPoint ?? 0.3,
      range: clinkz.s.attackRange, projSpeed: d?.projSpeed ?? 900, ms: 0, dayVision: 800, nightVision: 800, turnRate: 1, melee: false,
    }, x, y, duration, { name: 'clinkz_skeleton_archer', abilities: sa ? ['clinkz_searing_arrows'] : [], level: sa?.level ?? 1, bounty: d?.bountyGold, xp: d?.bountyXp });
    s.data_archer = true;
    s.addMod({
      name: 'skeleton_archer', persistent: true, states: ST.rooted, interval: 0.3,
      // Mueren por golpes: 2 de héroe, más de otras unidades; los hechizos no les afectan.
      onIncomingDamage(_m, ev) {
        if (ev.hpRemoval) return;
        if (!ev.isAttack) { ev.amount = 0; return; }
        const src = ev.source as Unit | null;
        ev.amount = src && src.isHeroLike ? hits / 2 : hits / 8;
      },
      onAttackLanded(_m, ev) { shred(s, ev); },
      // Disparan a lo que ataca Clinkz si está a su alcance.
      onInterval(m) {
        const v = m.owner as Unit;
        const t = clinkz.atk.target ? v.w.units.get(clinkz.atk.target) : null;
        if (!t || !t.alive || t.team === v.team || !v.w.targetable(t)) return;
        if (Math.hypot(t.x - v.x, t.y - v.y) > v.s.attackRange + 100) return;
        if (v.order?.type !== 'attack' || v.order.target !== t.id) v.w.issueOrder(v, { type: 'attack', target: t.id });
      },
    }, clinkz, null);
  }
}

defineAbility({
  key: 'clinkz_strafe', target: 'none', ai: { role: 'buff', selfRadius: 750 },
  // Lanzarla no rompe Skeleton Walk.
  passive: (a) => { a.data.keepInvis = true; return null; },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration');
    u.addMod({
      name: 'strafe', duration: d, fx: 'strafe',
      props: { attackSpeed: val(a, 'attack_speed_bonus'), attackRange: val(a, 'attack_range_bonus') },
    }, u, a);
    for (const s of archersOf(u)) {
      if (Math.hypot(s.x - u.x, s.y - u.y) > val(a, 'strafe_skeleton_radius')) continue;
      s.addMod({
        name: 'strafe', duration: d, fx: 'strafe',
        props: { attackSpeed: val(a, 'attack_speed_bonus') * val(a, 'archer_attack_speed_pct') / 100, attackRange: val(a, 'attack_range_bonus') },
      }, u, a);
    }
  },
});

// Orbe con autocast: se trata como interruptor; los bots lo llevan siempre activo.
defineAbility({
  key: 'clinkz_searing_arrows', target: 'toggle',
  passive: (a) => ({
    name: 'searing_arrows',
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit;
      m.data.on = false;
      const archer = isArcher(u);
      const owner = heroOf(u);
      if (!archer && !(a.toggled || owner.isBot)) return;
      if (u.kind === 'hero' && !archer) {
        const mc = val(a, '_mc');
        if (u.mana < mc || u.has(ST.silenced)) return;
        u.mana -= mc;
      }
      let bonus = val(a, 'damage_bonus');
      if (archer) bonus *= val(a, 'skeleton_damage_pct') / 100;
      ev.damage += bonus;
      m.data.on = true;
      // Talento: dispara también a otros dos enemigos cercanos.
      if (!ev.fake && !archer && val(a, 'has_multishot') > 0) {
        const extra = u.w.enemiesIn(u.team, u.x, u.y, u.s.attackRange + 100)
          .filter((e) => e !== ev.target && u.w.canSee(u.team, e)).slice(0, 2);
        for (const e of extra) u.w.after(0.05, () => { if (u.alive && e.alive) launchAttack(u, e, true); });
      }
    },
  }),
  onToggle() {},
});

defineAbility({
  key: 'clinkz_death_pact', target: 'unit', team: 'any', ai: aiBy('heal'),
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime')],
  passive: (a) => {
    a.data.keepInvis = true;
    return botCast(a, (u) => {
      if (u.hp / u.s.maxHp > 0.85 && u.findMod('death_pact')) return null;
      const c = u.w.list.filter((v) => v.alive && u.w.targetable(v) && Math.hypot(v.x - u.x, v.y - u.y) < 900 &&
        ((v.kind === 'creep' && v.team !== u.team && (UNITS[v.name]?.level ?? 1) <= val(a, 'creep_level')) || (v.owner === u && isArcher(v))))
        .sort((x, y) => Math.hypot(x.x - u.x, x.y - u.y) - Math.hypot(y.x - u.x, y.y - u.y))[0];
      return c ? { unit: c } : null;
    });
  },
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const c = t.unit as Unit;
    const ok = (c.kind === 'creep' && c.team !== u.team && (UNITS[c.name]?.level ?? 1) <= val(a, 'creep_level')) || (c.owner === u && isArcher(c));
    if (!ok || a.temp) { a.charges = Math.min(a.charges + 1, val(a, 'abilitycharges') || 1); u.mana += val(a, '_mc'); return; }
    u.w.emit({ n: 'death_pact', x: c.x, y: c.y, u: c.id, u2: u.id });
    // El creep muere a manos de Clinkz (recompensa incluida).
    dealDamage({ source: u, target: c, amount: c.hp + 10, type: 'pure', ability: a, isAttack: false, hpRemoval: true, noProc: true });
    const gain = val(a, 'health_gain');
    u.addMod({ name: 'death_pact', duration: val(a, 'duration'), fx: 'death_pact', props: { hp: gain } }, u, a);
    heal(u, gain, u);
  },
});

defineAbility({
  key: 'clinkz_burning_barrage', target: 'point', ai: { role: 'nuke' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    a.data.dir = [dx, dy];
    a.data.acc = 0;
    a.data.waves = 0;
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const waves = val(a, 'wave_count');
    const every = val(a, 'abilitychanneltime') / waves;
    a.data.acc += dt;
    while (a.data.acc >= every && a.data.waves < waves) {
      a.data.acc -= every;
      a.data.waves++;
      const [dx, dy] = a.data.dir as [number, number];
      u.w.addProjectile({
        kind: 'linear', fx: 'burning_barrage', source: u, x: u.x, y: u.y, dx, dy,
        speed: 2000, left: val(a, 'range'), width: val(a, 'projectile_width'),
        onHit(_p, e) {
          const v = e as Unit;
          if (v.team === u.team) return;
          const ev = makeAttack(u, v, true);
          ev.damage *= val(a, 'damage_pct') / 100;
          ev.trueStrike = true;
          landAttack(ev);
        },
      });
    }
  },
});

defineAbility({
  key: 'clinkz_burning_army', target: 'point', ai: { role: 'summon' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Fila de arqueros desde el punto, perpendicular a la dirección del lanzamiento.
    const [dx, dy] = castDir(u, t.x, t.y);
    const px = -dy, py = dx;
    const n = val(a, 'count');
    const len = val(a, 'range');
    const ww = abil(u, 'clinkz_wind_walk');
    const duration = ww ? val(ww, 'skeleton_duration') : 20;
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? -len / 2 + len * i / (n - 1) : 0;
      u.w.after(val(a, 'spawn_interval') * i, () => {
        if (u.alive) spawnArchers(u, [[t.x + px * off, t.y + py * off]], duration);
      });
    }
  },
});

defineAbility({
  key: 'clinkz_wind_walk', target: 'none', ult: true, ai: { role: 'escape', selfRadius: 1100 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const fade = val(a, 'fade_time');
    u.w.emit({ n: 'fade', x: u.x, y: u.y, u: u.id });
    u.addMod({ name: 'skeleton_walk_fade', duration: fade, states: ST.noCollision, props: { msPct: val(a, 'move_speed_bonus_pct') / 100 } }, u, a);
    u.w.after(fade, () => {
      if (!u.alive) return;
      u.addMod({
        name: 'skeleton_walk', duration: dur(a, 'duration'), fx: 'invis',
        states: ST.invisible | ST.noCollision, data: { breaksOnAttack: true },
        props: { msPct: val(a, 'move_speed_bonus_pct') / 100 },
        onDestroy() {
          if (!u.alive) return;
          // Al salir aparecen los arqueros alrededor.
          const n = val(a, 'skeleton_count');
          const pts: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const ang = u.facing + Math.PI + (i - (n - 1) / 2) * 0.7;
            const r = val(a, 'skeleton_offset_min') + u.w.rng() * (val(a, 'skeleton_offset') - val(a, 'skeleton_offset_min'));
            pts.push([u.x + Math.cos(ang) * r, u.y + Math.sin(ang) * r]);
          }
          spawnArchers(u, pts, val(a, 'skeleton_duration'));
        },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'clinkz_infernal_shred', target: 'passive', innate: true,
  passive: () => ({ name: 'infernal_shred_src', onAttackLanded(m, ev) { shred(m.owner as Unit, ev); } }),
});

defineHero('clinkz', ['clinkz_strafe', 'clinkz_searing_arrows', 'clinkz_death_pact', 'clinkz_burning_barrage', 'clinkz_burning_army', 'clinkz_wind_walk', 'clinkz_infernal_shred'], {
  build: ['wraith_band', 'power_treads', 'orchid', 'dragon_lance', 'black_king_bar', 'bloodthorn', 'greater_crit', 'satanic'],
  upgrades: [
    { slot: 0, key: 'attack_speed_bonus', amount: 25, max: 5, label: 'Strafe: +25 velocidad de ataque' },
    { slot: 1, key: 'damage_bonus', amount: 10, max: 5, label: 'Searing Arrows: +10 daño' },
    { slot: 2, key: 'health_gain', amount: 75, max: 5, label: 'Death Pact: +75 vida' },
    { slot: 5, key: 'skeleton_count', amount: 1, max: 3, label: 'Skeleton Walk: +1 arquero' },
    { slot: 5, key: 'move_speed_bonus_pct', amount: 5, max: 4, label: 'Skeleton Walk: +5% velocidad' },
  ],
});
