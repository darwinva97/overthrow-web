// Lifestealer: Rage, Open Wounds, Feast, Ghoul Frenzy (innata), Infest y Consume.
import { defineAbility, defineHero, dmg, dur, hasScepter, manaCostOf, val } from '../sim/abilities';
import { damage, heal, kill, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, nearestEnemyHero } from './lib/a4';
import { debuff } from './util';

const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const infestMod = (u: Unit) => u.findMod('infest');

/** Devuelve maná y enfriamiento de un lanzamiento que no vale. */
function refund(a: AbilityInst) {
  const u = a.owner as Unit;
  a.cd = 0;
  u.mana = Math.min(u.s.maxMana, u.mana + manaCostOf(a));
}

// ---------------- Rage ----------------

defineAbility({
  key: 'life_stealer_rage', target: 'none', ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    // Dentro de un huésped no se puede usar.
    if (infestMod(u)) { refund(a); return; }
    u.purge(true, false);
    u.addMod({
      name: 'rage', duration: dur(a, 'duration'), fx: 'rage', states: ST.magicImmune,
      props: {
        magicResist: val(a, 'magic_resist') / 100, msPct: val(a, 'movespeed_bonus') / 100,
        statusResist: val(a, 'status_resist') / 100, armor: val(a, 'bonus_armor'),
      },
    }, u, a);
  },
});

// ---------------- Open Wounds ----------------

defineAbility({
  key: 'life_stealer_open_wounds', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (infestMod(u)) { refund(a); return; }
    const d = dur(a, 'duration');
    const steps = a.def.values.slow_steps ?? [];
    debuff(u, e, a, {
      name: 'open_wounds', duration: d, fx: 'open_wounds',
      // El ralentizado baja por escalones cada segundo.
      props: (m) => {
        const i = Math.min(steps.length - 1, Math.floor(m.duration - m.remaining));
        return { msSlow: Math.abs(steps[Math.max(0, i)] ?? 0) / 100 * val(a, 'slow_step_pct_of_max') / 100 };
      },
      interval: 1,
      onInterval(m) { (m.owner as Unit).refreshStats(); },
      // Los aliados se curan un % del daño que le hacen.
      onTakeDamage(_m, ev) {
        const s = ev.source as Unit | null;
        if (!s || s.team !== u.team || !s.alive || ev.amount <= 0) return;
        heal(s, ev.amount * val(a, 'heal_percent') / 100, u, true);
      },
      // Talento: velocidad de ataque mientras Lifestealer ataca a este objetivo.
      onTick(m) {
        const as = val(a, 'attack_speed_on_target');
        if (as > 0 && u.atk.target === (m.owner as Unit).id) {
          u.addMod({ name: 'open_wounds_as', duration: 0.2, props: { attackSpeed: as } }, u, a);
        }
      },
    });
  },
});

// ---------------- Feast ----------------

defineAbility({
  key: 'life_stealer_feast', target: 'passive',
  passive: (a) => ({
    name: 'feast',
    props: () => ({ hp: a.data.hp ?? 0 }),
    onAttackLanded(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (ev.missed || t.kind === 'ward' || t.kind === 'fountain' || t.kind === 'throne') return;
      if (t.team === u.team) {
        // Denegar creeps propios: daño reducido.
        ev.damage += t.s.maxHp * val(a, 'hp_damage_percent') / 100 * val(a, 'creep_deny_percent') / 100 / ev.critMult;
        return;
      }
      if (t.has(ST.magicImmune) && !a.def.bkbPierce) return;
      // El daño extra no hace crítico.
      ev.damage += t.s.maxHp * val(a, 'hp_damage_percent') / 100 / ev.critMult;
      heal(u, t.s.maxHp * val(a, 'hp_leech_percent') / 100, u, true);
    },
    onKill(m, victim) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || victim.team === u.team) return;
      const gain = victim.kind === 'hero' ? val(a, 'bonus_hp_per_hero') : victim.kind === 'creep' ? val(a, 'bonus_hp_per_creep') : 0;
      if (!gain) return;
      a.data.hp = (a.data.hp ?? 0) + gain;
      m.stacks = a.data.hp;
      u.refreshStats();
    },
  }),
});

// ---------------- Ghoul Frenzy (innata) ----------------

defineAbility({
  key: 'life_stealer_ghoul_frenzy', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'ghoul_frenzy',
    props: { attackSpeed: val(a, 'attack_speed_bonus'), msPct: val(a, 'movement_speed_bonus') / 100 },
  }),
});

// ---------------- Infest / Consume ----------------

/** Sale del huésped: explosión, y si era un creep, se lo come. */
function exitInfest(u: Unit, consume: boolean) {
  const m = infestMod(u);
  if (!m || m.data.exiting) return;
  m.data.exiting = true;
  const a = m.ability as AbilityInst;
  const host = u.w.units.get(m.data.host);
  const w = u.w;
  u.removeMod(m);
  if (host) {
    host.removeModsByName('infest_host');
    w.teleport(u, host.x + Math.cos(host.facing + Math.PI) * 60, host.y + Math.sin(host.facing + Math.PI) * 60);
  }
  u.order = null; u.atk.phase = 0;
  const r = val(a, 'radius');
  w.emit({ n: 'infest_burst', x: u.x, y: u.y, r, u: u.id, t: u.team });
  for (const e of w.enemiesIn(u.team, u.x, u.y, r)) damage(u, e, dmg(a, 'damage'), 'magical', a);
  if (!host || !host.alive || !consume || host.kind === 'hero' || host.kind === 'illusion') return;
  // Shard: al comerse un creep, empapa de sangre a los enemigos (DoT según la vida del huésped).
  const pct = val(a, 'dot_damage_as_pct_of_damage_dealt');
  const dd = val(a, 'dot_duration'), tick = val(a, 'dot_tick_interval');
  if (pct > 0 && dd > 0 && tick > 0) {
    const total = host.hp * pct / 100;
    for (const e of w.enemiesIn(u.team, u.x, u.y, r)) {
      debuff(u, e, a, {
        name: 'infest_blood', duration: dd, interval: tick, fx: 'blood',
        onInterval(mm) { damage(u, mm.owner as Unit, total * tick / dd, 'magical', a, { noProc: true }); },
      });
    }
  }
  kill(host, u);
}

defineAbility({
  key: 'life_stealer_infest', target: 'unit', team: 'any', ult: true,
  // IA: para curarse o escapar se mete en un aliado o creep cercano; con Scepter, en un enemigo.
  passive: (a) => botBrain(a, (u) => {
    if (infestMod(u)) return null;
    const enemy = nearestEnemyHero(u, 900);
    if (!enemy) return null;
    const hp = u.hp / u.s.maxHp;
    if (hasScepter(u) && hp > 0.4 && enemy.kind === 'hero' && !enemy.has(ST.magicImmune) &&
      Math.hypot(enemy.x - u.x, enemy.y - u.y) < val(a, 'abilitycastrange') + 200) return { target: enemy };
    if (hp > 0.35) return null;
    let best: Unit | null = null, bd = 800;
    for (const h of u.w.list) {
      if (!h.alive || h === u || !u.w.targetable(h) || !u.w.canSee(u.team, h) || h.has(ST.magicImmune) && h.team !== u.team) continue;
      const ok = h.team === u.team ? (h.kind === 'hero' || h.kind === 'creep' || h.kind === 'summon') : h.kind === 'creep';
      if (!ok) continue;
      const d = Math.hypot(h.x - u.x, h.y - u.y);
      if (d < bd) { bd = d; best = h; }
    }
    return best ? { target: best } : null;
  }, 0.4),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const host = t.unit as Unit;
    const w = u.w;
    const ally = host?.team === u.team;
    const enemyHero = !!host && !ally && host.isHeroLike;
    // Aliados (héroes, creeps, invocaciones) y creeps enemigos o neutrales; héroes enemigos solo con Scepter.
    const valid = host && host !== u && !infestMod(u) && host.kind !== 'ward' && host.kind !== 'fountain' &&
      (ally ? host.kind !== 'illusion' : host.kind === 'creep' || (enemyHero && host.kind === 'hero' && hasScepter(u)));
    if (!valid) { refund(a); w.error(u, 'Objetivo no válido'); return; }
    u.purge(true, false);
    w.disjoint(u);
    u.order = null; u.queue = []; u.atk.phase = 0;
    w.emit({ n: 'infest', x: host.x, y: host.y, u: host.id, u2: u.id, t: u.team });
    // Creep enemigo o neutral: pasa a obedecer a Lifestealer.
    if (!ally && host.kind === 'creep') {
      host.team = u.team; host.owner = u; host.playerId = u.playerId; host.home = null;
      host.order = null; host.atk.phase = 0;
    }
    const controlled = host.kind !== 'hero' && host.team === u.team;
    if (!enemyHero) {
      host.addMod({
        name: 'infest_host', fx: 'infested', interval: 1,
        props: { msPct: val(a, 'bonus_movement_speed') / 100, hp: val(a, 'bonus_health') },
        onInterval(mm) {
          const pct = val(a, 'creep_max_hp_drain_pct_per_second');
          const h = mm.owner as Unit;
          if (controlled && pct > 0) damage(u, h, h.s.maxHp * pct / 100, 'pure', a, { hpRemoval: true, noProc: true });
        },
      }, u, a);
    }
    const until = enemyHero ? w.time + val(a, 'infest_duration_enemy') : Infinity;
    u.addMod({
      name: 'infest', fx: 'infest',
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.noCollision | ST.disarmed,
      data: { host: host.id, enemy: enemyHero, acc: 0, at: w.time },
      onTick(m, dt) {
        const h = w.units.get(m.data.host);
        // Sale solo si el huésped muere o, dentro de un enemigo (Scepter), al acabar el tiempo.
        if (!h || !h.alive || w.time >= until || (m.data.enemy && h.has(ST.magicImmune))) { exitInfest(u, false); return; }
        u.x = h.x; u.y = h.y; u.facing = h.facing;
        heal(u, u.s.maxHp * val(a, 'self_regen') / 100 * dt, u, true);
        // Scepter: ataca desde dentro al héroe enemigo.
        const rate = val(a, 'attack_rate_enemy');
        if (m.data.enemy && rate > 0) {
          m.data.acc += dt;
          if (m.data.acc >= 1 / rate) { m.data.acc -= 1 / rate; launchAttack(u, h, true); }
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'life_stealer_consume', target: 'none', levelWith: 4,
  hidden: (a) => !infestMod(a.owner as Unit),
  // IA: sale cuando está curado, cuando hay enemigos a tiro o si el huésped se muere.
  passive: (a) => botBrain(a, (u) => {
    const m = infestMod(u);
    if (!m || m.data.enemy) return null;
    const host = u.w.units.get(m.data.host);
    const inf = abil(u, 'life_stealer_infest');
    const r = inf ? val(inf, 'radius') : 0;
    const hp = u.hp / u.s.maxHp;
    const near = host ? nearestEnemyHero(host, r * 0.5) : null;
    if (hp > 0.95 || (near && hp > 0.6) || (host && host.hp < host.s.maxHp * 0.25) || u.w.time - m.data.at > 15) return { x: u.x, y: u.y };
    return null;
  }, 0.3, 'bot_brain_consume'),
  onSpellStart(a) { exitInfest(a.owner as Unit, true); },
});

defineHero('life_stealer', ['life_stealer_rage', 'life_stealer_open_wounds', 'life_stealer_feast', 'life_stealer_ghoul_frenzy', 'life_stealer_infest', 'life_stealer_consume'], {
  build: ['bracer', 'phase_boots', 'armlet', 'sange_and_yasha', 'basher', 'black_king_bar', 'abyssal_blade', 'assault'],
});
