import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, silence, slow } from './util';
import { fear } from './lib/a2';

defineAbility({
  key: 'death_prophet_carrion_swarm', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'crypt_swarm', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'),
      left: val(a, 'range') + u.s.castRange, width: val(a, 'start_radius') * 2, widthEnd: val(a, 'end_radius') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.has(ST.magicImmune)) return;
        damage(u, v, dmg(a, 'damage'), 'magical', a);
        scepterGhost(u, v);
        if (val(a, 'slow_percent') > 0) slow(u, v, a, 'crypt_swarm', val(a, 'slow_duration'), val(a, 'slow_percent') / 100);
      },
    });
  },
});

defineAbility({
  key: 'death_prophet_silence', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const r = val(a, 'radius');
    u.w.emit({ n: 'dp_silence', x: u.x, y: u.y, x2: t.x, y2: t.y, r, d: d / val(a, 'projectile_speed'), t: u.team });
    u.w.after(d / val(a, 'projectile_speed'), () => {
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        silence(u, e, dur(a, 'abilityduration'), a, 'dp_silence');
        scepterGhost(u, e);
      }
    });
  },
});

defineAbility({
  key: 'death_prophet_spirit_siphon', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  charges: (a) => [val(a, 'abilitycharges') + val(a, 'shard_bonus_charges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const every = 0.25;
    let linked = 0;
    let feared = false;
    debuff(u, e, a, {
      name: 'spirit_siphon', duration: dur(a, 'haunt_duration'), fx: 'spirit_siphon', interval: every,
      onInterval(m) {
        const v = m.owner as Unit;
        if (!u.alive || Math.hypot(v.x - u.x, v.y - u.y) > castRangeOf(a) + val(a, 'siphon_buffer')) { m.remaining = 0.001; return; }
        const amt = (dmg(a, 'damage') + v.s.maxHp * val(a, 'damage_pct') / 100) * every;
        const done = damage(u, v, amt, 'magical', a, { noProc: true });
        heal(u, done, u, true);
        linked += every;
        // Shard: miedo si el enlace dura lo bastante seguido.
        if (!feared && hasShard(u) && linked >= val(a, 'shard_consecutive_siphon_duration')) {
          feared = true;
          fear(u, v, val(a, 'shard_fear_duration'), a, 'siphon_fear');
        }
      },
    });
    scepterGhost(u, e);
  },
});

/** Witchcraft: velocidad de movimiento por nivel. */
defineAbility({
  key: 'death_prophet_witchcraft', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'witchcraft', interval: 1,
    props: (m) => {
      const u = m.owner as Unit;
      return { msPct: u.level * val(a, 'movement_speed_pct') / 100, cdr: u.level * val(a, 'cooldown_reduction_pct') / 100 };
    },
    onInterval(m) {
      const u = m.owner as Unit;
      if (m.data.lvl !== u.level) { m.data.lvl = u.level; u.refreshStats(); }
    },
  }),
});

/** Espíritu que vuela a un enemigo, le daña y vuelve a Death Prophet. */
function spirit(a: AbilityInst, u: Unit, target: Unit, amount: () => number, onBack: (dealt: number) => void, fx = 'exorcism_spirit') {
  const speed = val(a, 'spirit_speed');
  const giveUp = val(a, 'give_up_distance');
  const pickNew = () => {
    const list = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius')).filter((e) => e.kind !== 'ward');
    return list.length ? list[Math.floor(u.w.rng() * list.length)] : null;
  };
  const goBack = (x: number, y: number, dealt: number) => {
    u.w.addProjectile({
      kind: 'track', fx, source: u, target: u, x, y, speed,
      onHit() { onBack(dealt); return true; },
    });
  };
  u.w.addProjectile({
    kind: 'track', fx, source: u, target, x: u.x, y: u.y, speed,
    onThink(p) {
      const t = p.target as Unit | null;
      if (!t || !t.alive || !u.w.targetable(t) || Math.hypot(t.x - u.x, t.y - u.y) > giveUp) {
        const n = pickNew();
        if (n) p.target = n;
        else { p.dead = true; goBack(p.x, p.y, 0); }
      }
    },
    onHit(p, t) {
      const dealt = damage(u, t as Unit, amount(), 'physical', a, { noProc: true, data: { exorcism: true } });
      goBack(p.x, p.y, dealt);
      return true;
    },
  });
}

/** Scepter: un fantasma golpea a cada enemigo afectado por sus hechizos o ataques. */
function scepterGhost(u: Unit, e: Unit) {
  if (!hasScepter(u) || e.team === u.team || !e.alive) return;
  const a = u.abilities.find((x) => x.key === 'death_prophet_exorcism' && x.level > 0);
  if (!a) return;
  const last = (e.data_dpGhost ?? -9) as number;
  if (u.w.time - last < 1) return;
  e.data_dpGhost = u.w.time;
  spirit(a, u, e, () => val(a, 'average_damage') * (1 + val(a, 'scepter_spirit_bonus_damage') / 100),
    (dealt) => heal(u, dealt * val(a, 'heal_percent') / 100, u, true), 'exorcism_ghost');
}

defineAbility({
  key: 'death_prophet_exorcism', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 700 },
  // Scepter: los ataques de Death Prophet también sueltan fantasmas.
  passive: () => ({
    name: 'exorcism_scepter',
    onAttackLanded(m, ev) { if (!ev.fake) scepterGhost(m.owner as Unit, ev.target as Unit); },
  }),
  noIllusion: true,
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.removeModsByName('exorcism');
    const total = val(a, 'spirits');
    let spawned = 0;
    let free = 0;
    let dealtTotal = 0;
    u.addMod({
      name: 'exorcism', duration: dur(a, 'abilityduration'), fx: 'exorcism', interval: 0.1,
      props: { msFlat: val(a, 'movement_bonus') },
      onInterval(m) {
        m.data.spawnAcc = (m.data.spawnAcc ?? 0) + 0.1;
        while (spawned < total && m.data.spawnAcc >= val(a, 'ghost_spawn_rate')) { m.data.spawnAcc -= val(a, 'ghost_spawn_rate'); spawned++; free++; }
        m.stacks = spawned;
        const enemies = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius')).filter((e) => e.kind !== 'ward');
        if (!enemies.length) return;
        // Prefieren lo que ataca Death Prophet.
        const focus = u.w.units.get(u.atk.target);
        while (free > 0) {
          free--;
          const t = focus && enemies.includes(focus) && u.w.rng() < 0.5 ? focus : enemies[Math.floor(u.w.rng() * enemies.length)];
          spirit(a, u, t, () => val(a, 'min_damage') + u.w.rng() * (val(a, 'max_damage') - val(a, 'min_damage')),
            (d) => { dealtTotal += d; if (u.findMod('exorcism')) free++; });
        }
      },
      onAnyDeath(m, victim) {
        if (victim.kind === 'hero' && victim.team !== u.team && val(a, 'duration_increase_per_kill') > 0) {
          m.remaining += val(a, 'duration_increase_per_kill');
        }
      },
      onDestroy() {
        if (u.alive) heal(u, dealtTotal * val(a, 'heal_percent') / 100, u);
      },
    }, u, a);
  },
});

defineHero('death_prophet', ['death_prophet_carrion_swarm', 'death_prophet_silence', 'death_prophet_spirit_siphon', 'death_prophet_witchcraft', 'death_prophet_exorcism'], {
  build: ['null_talisman', 'arcane_boots', 'kaya', 'black_king_bar', 'shivas_guard', 'ultimate_scepter', 'refresher', 'octarine_core'],
  upgrades: [
    { slot: 0, key: 'damage', amount: 40, max: 5, label: 'Crypt Swarm: +40 daño' },
    { slot: 1, key: 'abilityduration', amount: 0.4, max: 4, label: 'Silence: +0,4 s' },
    { slot: 2, key: 'damage', amount: 12, max: 5, label: 'Spirit Siphon: +12 daño por segundo' },
    { slot: 4, key: 'spirits', amount: 3, max: 4, label: 'Exorcism: +3 espíritus' },
    { slot: 4, key: 'heal_percent', amount: 8, max: 4, label: 'Exorcism: +8% de curación' },
  ],
});
