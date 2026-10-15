import { UNITS } from '../data';
import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, val } from '../sim/abilities';
import { damage, kill } from '../sim/combat';
import type { AbilityInst, AttackEvent, ModSpec, Props } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { castDir, debuff, slow, stun } from './util';
import { botTick, dist, enemyHeroes, fear, heroOf, lockSub, summonBrain, unlockSub, valAt } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'brewmaster_thunder_clap', target: 'none', ai: { role: 'aoe', selfRadius: 350 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'nova', x: u.x, y: u.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (e.alive) slow(u, e, a, 'thunder_clap', dur(a, 'duration'), val(a, 'movement_slow') / 100, val(a, 'attack_speed_slow'));
    }
  },
});

/** Empapa de Cinder Brew: ralentiza; el daño mágico o puro lo enciende. */
function drench(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  debuff(u, e, a, {
    name: 'cinder_brew', duration: dur(a, 'duration'), fx: 'slow',
    props: { msSlow: val(a, 'movement_slow') / 100 },
    onTakeDamage(m, ev) {
      if (m.data.lit || ev.amount <= 0 || ev.type === 'physical' || ev.data?.cinder) return;
      m.data.lit = true;
      const v = m.owner as Unit;
      m.remaining += val(a, 'extra_duration');
      const total = m.remaining;
      const per = dmg(a, 'total_ignite_damage') / Math.max(1, total / 0.5);
      m.interval = 0.5; m.acc = 0;
      m.onInterval = () => { damage(u, v, per, 'magical', a, { noProc: true, data: { cinder: true } }); };
      m.fx = 'burn';
      // Talento: miedo al encenderse.
      const fd = val(a, 'fear_duration');
      if (fd > 0) fear(u, v, fd, a, u.x, u.y);
    },
  });
}

defineAbility({
  key: 'brewmaster_cinder_brew', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = Math.max(1, Math.min(dist(u, t), val(a, 'abilitycastrange') + u.s.castRange));
    const hit = new Set<number>();
    u.w.addProjectile({
      kind: 'linear', fx: 'cinder_brew', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'projectile_speed'), left: len,
      width: val(a, 'barrel_width') * 2,
      onHit(_p, e) {
        if (e.team === u.team || hit.has(e.id)) return false;
        hit.add(e.id);
        drench(a, e as Unit);
        damage(u, e as Unit, dmg(a, 'barrel_impact_damage'), 'magical', a);
        return false;
      },
      onEnd(p) {
        const r = val(a, 'radius');
        u.w.emit({ n: 'cinder_brew', x: p.x, y: p.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, p.x, p.y, r)) drench(a, e);
      },
    });
  },
});

// ---------------- Drunken Brawler ----------------

const STANCES = ['earth', 'storm', 'fire'] as const;
type Stance = typeof STANCES[number];

/** Bonus de una postura con un multiplicador de potencia (Brewed Up). */
function stanceProps(a: AbilityInst, s: Stance, k: number): Partial<Props> {
  if (s === 'earth') return { magicResist: val(a, 'magic_resist') / 100 * k, armor: val(a, 'bonus_armor') * k };
  if (s === 'storm') return { evasion: Math.min(1, val(a, 'dodge_chance') / 100 * k), msPct: val(a, 'bonus_move_speed') / 100 * k };
  return { attackSpeed: val(a, 'attack_speed') * k };
}
function fireCrit(a: AbilityInst, k: number, ev: AttackEvent) {
  if ((ev.attacker as Unit).w.rng() < val(a, 'crit_chance') / 100) ev.critMult = Math.max(ev.critMult, 1 + (val(a, 'crit_multiplier') / 100 - 1) * k);
}
const brewMult = (a: AbilityInst, brewed: boolean) => (brewed ? 1 + val(a, 'brewed_up_bonus') / 100 : 1);

/** Mod de postura fija (para los brewlings). */
function fixedStance(a: AbilityInst, s: Stance, brewedFor: number): ModSpec {
  const until = (a.owner as Unit).w.time + brewedFor;
  return {
    name: 'drunken_brawler_' + s, persistent: true, interval: 0.5,
    props: (m) => stanceProps(a, s, brewMult(a, (m.owner as Unit).w.time < until)),
    onInterval(m) { if ((m.owner as Unit).w.time - 0.5 < until) (m.owner as Unit).refreshStats(); },
    onAttackStart(m, ev) { if (s === 'fire') fireCrit(a, brewMult(a, (m.owner as Unit).w.time < until), ev); },
  };
}

defineAbility({
  key: 'brewmaster_drunken_brawler', target: 'none',
  onLevelUp(a) { a.data.stance ??= 2; },
  passive: (a) => ({
    name: 'drunken_brawler',
    props: () => stanceProps(a, STANCES[a.data.stance ?? 2], brewMult(a, (a.owner as Unit).w.time < (a.data.brewedUntil ?? 0))),
    onAttackStart(_m, ev) {
      if (STANCES[a.data.stance ?? 2] === 'fire') fireCrit(a, brewMult(a, (a.owner as Unit).w.time < (a.data.brewedUntil ?? 0)), ev);
    },
    // Brewed Up: cada habilidad lanzada potencia la postura; luego viene la resaca.
    onAbilityExecuted(_m, ab) {
      const u = a.owner as Unit;
      if (isItem(ab) || ab.key === a.key) return;
      const now = u.w.time;
      if (now < (a.data.brewedUntil ?? 0)) a.data.brewedUntil += val(a, 'brewed_up_duration_extend');
      else if (now >= (a.data.hangoverUntil ?? 0)) a.data.brewedUntil = now + val(a, 'brewed_up_duration');
      else return;
      a.data.hangoverUntil = a.data.brewedUntil + val(a, 'hangover_time');
      u.refreshStats();
    },
    onTick(m, dt) {
      const u = m.owner as Unit;
      const brewed = u.w.time < (a.data.brewedUntil ?? 0);
      if (brewed !== m.data.brewed) { m.data.brewed = brewed; m.fx = brewed ? 'berserk' : undefined; u.refreshStats(); }
      // Bots: fuego para pelear, tierra si van mal, tormenta para moverse.
      botTick(a, (b) => {
        const foes = enemyHeroes(b, 700);
        const want: Stance = !foes.length ? 'storm' : b.hp / b.s.maxHp < 0.45 ? 'earth' : 'fire';
        return STANCES[a.data.stance ?? 2] !== want ? {} : null;
      }, 1)(m, dt);
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    a.data.stance = ((a.data.stance ?? 2) + 1) % STANCES.length;
    u.refreshStats();
  },
});

// ---------------- Liquid Courage ----------------

defineAbility({
  key: 'brewmaster_liquid_courage', target: 'unit', team: 'ally', allowSelf: true, innate: true,
  hidden: (a) => !hasShard(a.owner as Unit),
  // Con Shard se vuelve activa (sin Shard queda bloqueada).
  charges: (a) => [1, hasShard(a.owner as Unit) ? val(a, '_cd') : 1e9],
  passive: (a) => {
    const u = a.owner as Unit;
    if (!hasShard(u)) { lockSub(a); a.data.locked = true; } else if (a.data.locked) { unlockSub(a); a.data.locked = false; }
    const bot = botTick(a, (b) => (b.hp / b.s.maxHp < 0.5 && enemyHeroes(b, 800).length ? { unit: b } : null));
    return {
      name: 'liquid_courage', interval: 0.25, data: { k: 0, fast: false },
      props: (m) => courageProps(a, m.data.k, m.data.fast),
      onInterval(m) {
        const v = m.owner as Unit;
        const p = v.hp / v.s.maxHp * 100;
        const lo = val(a, 'min_health_threshold'), hi = val(a, 'max_health_threshold');
        const k = p >= lo ? 0 : Math.min(1, (lo - p) / (lo - hi));
        const fast = Math.floor(v.w.time / val(a, 'speed_toggle_time')) % 2 === 0;
        if (k !== m.data.k || fast !== m.data.fast) { m.data.k = k; m.data.fast = fast; v.refreshStats(); }
      },
      onTick: bot,
    };
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const apply = () => e.addMod({
      name: 'liquid_courage_drink', duration: val(a, 'drink_duration'), fx: 'haste', interval: 0.25,
      props: () => ({ ...courageProps(a, 1, Math.floor(e.w.time / val(a, 'speed_toggle_time')) % 2 === 0), hpRegenPct: val(a, 'max_hp_regen') / 100 }),
      onInterval() { e.refreshStats(); },
    }, u, a);
    if (e === u) { apply(); return; }
    u.w.addProjectile({ kind: 'track', fx: 'liquid_courage', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), onHit() { apply(); return true; } });
  },
});

/** Resistencia de estado y velocidad alterna (rápida/lenta cada segundo) según la potencia k. */
function courageProps(a: AbilityInst, k: number, fast: boolean): Partial<Props> {
  if (k <= 0) return {};
  return { statusResist: val(a, 'status_resist') / 100 * k, msPct: (fast ? val(a, 'max_speed') : val(a, 'min_speed')) / 100 * k };
}

// ---------------- Primal Split ----------------

const SPLIT_ABILS: Record<Stance, string[]> = {
  earth: ['brewmaster_earth_hurl_boulder', 'brewmaster_earth_pulverize', 'brewmaster_earth_spell_immunity', 'brewmaster_primal_split_cancel'],
  storm: ['brewmaster_storm_dispel_magic', 'brewmaster_storm_cyclone', 'brewmaster_storm_wind_walk', 'brewmaster_primal_split_cancel'],
  fire: ['brewmaster_fire_permanent_immolation', 'brewmaster_fire_phase', 'brewmaster_primal_split_cancel'],
};

function brewlingBase(el: Stance, hp: number, dmgv: number): BaseStats {
  const d = UNITS['brewmaster_' + el + '_1'];
  return {
    hp, hpRegen: d.hpRegen, mana: d.mana, manaRegen: d.manaRegen, armor: d.armor, mr: d.mr,
    dmgMin: dmgv - 5, dmgMax: dmgv + 5, bat: d.bat, attackPoint: d.attackPoint, range: d.range, projSpeed: d.projSpeed,
    ms: d.ms, dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: d.melee,
  };
}

const brewlingsOf = (u: Unit) => u.w.list.filter((s) => s.alive && s.owner === u && s.data_brewling);

function endSplit(u: Unit) {
  const m = u.findMod('primal_split');
  if (m) u.removeMod(m);
}

defineAbility({
  key: 'brewmaster_primal_split', target: 'none', ult: true, ai: { role: 'summon', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (u.kind !== 'hero') return;
    const lvl = a.level + (hasScepter(u) ? val(a, 'scepter_bonus_levels') : 0);
    u.addMod({ name: 'primal_split_start', duration: val(a, 'split_duration'), states: ST.invulnerable | ST.stunned, fx: 'doppel' }, u, a);
    u.w.after(val(a, 'split_duration'), () => {
      if (!u.alive) return;
      const d = dur(a, 'duration');
      const brawler = find(u, 'brewmaster_drunken_brawler');
      const brewed = hasScepter(u) && brawler ? val(brawler, 'brewed_up_duration') : 0;
      const spawned: Unit[] = [];
      STANCES.forEach((el, i) => {
        const ang = u.facing + (i - 1) * 2.1;
        const s = u.w.spawnSummon(u, brewlingBase(el, valAt(a, `tooltip_${el}_brewling_hp`, lvl), valAt(a, `tooltip_${el}_brewling_damage`, lvl)),
          u.x + Math.cos(ang) * 120, u.y + Math.sin(ang) * 120, d, { name: 'brewmaster_' + el + '_1', abilities: SPLIT_ABILS[el], level: lvl, bounty: 0, xp: 0 });
        s.data_brewling = el;
        if (brawler && brawler.level > 0 && val(a, 'give_brawler_passive') > 0) s.addMod(fixedStance(brawler, el, brewed), u, brawler);
        s.addMod({
          name: 'brewling', persistent: true,
          onDeath(_m, killer) {
            // Si caen todos, cae Brewmaster.
            if (!u.alive || !u.findMod('primal_split')) return;
            if (brewlingsOf(u).length) return;
            const pm = u.findMod('primal_split');
            if (pm) pm.data.dead = true;
            endSplit(u);
            kill(u, killer as Unit);
          },
        }, u, a);
        summonBrain(s);
        spawned.push(s);
      });
      u.w.disjoint(u);
      if (u.cast) u.w.interruptCast(u, true);
      u.addMod({
        name: 'primal_split', duration: d + 0.1, purgable: false,
        states: ST.hidden | ST.invulnerable | ST.untargetable | ST.stunned | ST.noCollision,
        onTick() {
          const lead = brewlingsOf(u)[0];
          if (lead) { u.x = lead.x; u.y = lead.y; }
        },
        onDestroy(m) {
          const alive = brewlingsOf(u);
          const lead = alive[0];
          for (const s of alive) s.expireAt = u.w.time;
          if (m.data.dead || !u.alive) return;
          if (lead) u.w.teleport(u, lead.x, lead.y);
          u.order = null;
          u.w.emit({ n: 'respawn', x: u.x, y: u.y, u: u.id });
        },
      }, u, a);
    });
  },
});

// ---------------- Habilidades de los brewlings ----------------

defineAbility({
  key: 'brewmaster_primal_split_cancel', target: 'none',
  hidden: (a) => !hasScepter(heroOf(a.owner as Unit)),
  charges: (a) => [1, val(a, '_cd')],
  passive: (a) => { if (!hasScepter(heroOf(a.owner as Unit))) lockSub(a); return null; },
  onSpellStart(a) { endSplit(heroOf(a.owner as Unit)); },
});

defineAbility({
  key: 'brewmaster_earth_hurl_boulder', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'hurl_boulder', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: true,
      onHit() { damage(u, e, dmg(a, 'damage'), 'magical', a); stun(u, e, val(a, 'duration'), a); return true; },
    });
  },
});

defineAbility({ key: 'brewmaster_earth_pulverize', target: 'passive' });

defineAbility({
  key: 'brewmaster_earth_spell_immunity', target: 'passive',
  passive: (a) => ({
    name: 'earth_spell_immunity',
    props: { magicResist: val(a, 'magic_resist') / 100, statusResist: val(a, 'status_resist') / 100, slowResist: val(a, 'slow_resist') / 100 },
  }),
});

defineAbility({
  key: 'brewmaster_storm_dispel_magic', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'nova', x: t.x, y: t.y, r, t: u.team });
    for (const v of u.w.unitsIn(t.x, t.y, r, (x) => u.w.targetable(x) && x.kind !== 'fountain')) {
      if (v.team === u.team) { v.purge(true, false); continue; }
      if (v.has(ST.magicImmune)) continue;
      v.purge(false, true);
      if (v.kind === 'summon' || v.kind === 'illusion') damage(u, v, val(a, 'damage'), 'pure', a);
    }
  },
});

defineAbility({
  key: 'brewmaster_storm_cyclone', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e.cast) e.w.interruptCast(e, true);
    e.w.disjoint(e);
    debuff(u, e, a, {
      name: 'cyclone', duration: e.isHeroLike ? val(a, 'duration_hero') : val(a, 'duration_unit'), purgable: false, fx: 'cyclone',
      states: ST.stunned | ST.invulnerable | ST.untargetable,
      onDestroy(m) { damage(u, m.owner as Unit, val(a, 'landing_damage'), 'magical', a); },
    });
  },
});

defineAbility({
  key: 'brewmaster_storm_wind_walk', target: 'none', ai: { role: 'escape', selfRadius: 0 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'fade', x: u.x, y: u.y, u: u.id });
    u.w.after(val(a, 'fade_time'), () => {
      if (!u.alive) return;
      u.addMod({
        name: 'storm_wind_walk', duration: dur(a, 'duration'), fx: 'invis', states: ST.invisible | ST.noCollision,
        props: { msPct: val(a, 'bonus_movement_speeed') / 100 }, data: { breaksOnAttack: true },
        onAttackStart(_m, ev) { ev.damage += val(a, 'bonus_damage'); },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'brewmaster_fire_permanent_immolation', target: 'passive',
  passive: (a) => ({
    name: 'permanent_immolation', interval: 0.5, fx: 'radiance',
    onInterval(m) {
      const u = m.owner as Unit;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) damage(u, e, val(a, 'damage') * 0.5, 'magical', a, { noProc: true });
    },
  }),
});

defineAbility({
  key: 'brewmaster_fire_phase', target: 'passive',
  passive: (a) => ({ name: 'fire_phase', states: ST.noCollision, props: { statusResist: val(a, 'status_resistance') / 100 } }),
});

defineHero('brewmaster', ['brewmaster_thunder_clap', 'brewmaster_cinder_brew', 'brewmaster_drunken_brawler', 'brewmaster_liquid_courage', 'brewmaster_primal_split'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'ultimate_scepter', 'shivas_guard', 'refresher'],
});
