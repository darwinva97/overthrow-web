// Daño, curación, ataques y muertes.
import type { AbilityInst, AttackEvent, DamageEvent, DamageType, ItemInst } from './types';
import { ST } from './types';
import { armorMult, type Unit } from './unit';

/** Héroe que se lleva el crédito de lo que hace una ilusión, ward o invocación. */
export function creditHero(u: Unit | null): Unit | null {
  let c = u;
  for (let i = 0; c && i < 4; i++) {
    if (c.kind === 'hero') return c;
    c = c.owner as Unit | null;
  }
  return null;
}

let damageDepth = 0;

export function dealDamage(ev: DamageEvent): number {
  // Red de seguridad: reflejos encadenados (Blade Mail ↔ Dispersion…) no pueden recursar sin fin.
  if (damageDepth > 6) return 0;
  damageDepth++;
  try { return dealDamageInner(ev); } finally { damageDepth--; }
}

function dealDamageInner(ev: DamageEvent): number {
  const t = ev.target as Unit;
  const src = ev.source as Unit | null;
  if (!t.alive || t.has(ST.invulnerable)) return 0;
  if (ev.type === 'physical' && t.has(ST.ethereal) && !ev.hpRemoval) return 0;
  let amt = ev.amount;
  if (!ev.hpRemoval) {
    if (src && ev.ability && !ev.isAttack) amt *= 1 + src.s.spellAmp;
    if (src) amt *= 1 + src.s.outgoingPct;
    if (ev.type === 'physical') {
      if (ev.isAttack) amt = Math.max(0, amt - t.s.damageBlock);
      amt *= armorMult(t.s.armor);
    } else if (ev.type === 'magical') {
      amt *= 1 - t.s.mr;
      if (t.has(ST.ethereal)) amt *= 1.4;
    }
    amt *= 1 + t.s.incomingPct;
  }
  ev.amount = Math.max(0, amt);
  for (const m of t.hooks()) m.onIncomingDamage?.(m, ev);
  if (ev.amount <= 0) return 0;
  const w = t.w;
  if (ev.data?.nonLethal) ev.amount = Math.min(ev.amount, t.hp - 1);
  if (ev.amount <= 0) return 0;
  t.hp -= ev.amount;
  t.lastDamageAt = w.time;
  const credit = creditHero(src);
  if (credit && credit.team !== t.team) {
    t.damagedBy.set(credit.id, w.time);
    t.lastHeroDamageAt = w.time;
  }
  if (src) for (const m of src.hooks()) m.onDealDamage?.(m, ev);
  for (const m of t.hooks()) m.onTakeDamage?.(m, ev);
  if (src && src.alive && !ev.noProc && t.kind !== 'fountain') {
    if (ev.isAttack && src.s.lifesteal > 0) heal(src, ev.amount * src.s.lifesteal, null, true);
    else if (!ev.isAttack && ev.ability && src.s.spellLifesteal > 0) {
      heal(src, ev.amount * src.s.spellLifesteal * (t.isHeroLike ? 1 : 0.2), null, true);
    }
  }
  if (ev.crit || (ev.ability && ev.amount >= 1) ) {
    w.emit({ n: 'num', x: t.x, y: t.y, v: Math.round(ev.amount), c: ev.crit ? 'crit' : ev.type, u: t.id, t: src?.team });
  }
  if (t.hp <= 0) {
    t.hp = 0;
    kill(t, src);
  }
  return ev.amount;
}

/** Atajo para habilidades. */
export function damage(src: Unit | null, t: Unit, amount: number, type: DamageType,
  ability: AbilityInst | ItemInst | null, extra: Partial<DamageEvent> = {}) {
  return dealDamage({ source: src, target: t, amount, type, ability, isAttack: false, ...extra });
}

export function heal(u: Unit, amount: number, _src: Unit | null = null, silent = false) {
  if (!u.alive || amount <= 0 || u.has(ST.disarmedSpells)) return 0;
  amount *= Math.max(0, 1 + u.s.healAmp);
  const before = u.hp;
  u.hp = Math.min(u.s.maxHp, u.hp + amount);
  const d = u.hp - before;
  if (!silent && d >= 5) u.w.emit({ n: 'num', x: u.x, y: u.y, v: Math.round(d), c: 'heal', u: u.id });
  return d;
}

export function giveMana(u: Unit, amount: number) {
  if (!u.alive) return;
  u.mana = Math.min(u.s.maxMana, u.mana + amount);
}

export function burnMana(u: Unit, amount: number) {
  const b = Math.min(u.mana, amount);
  u.mana -= b;
  return b;
}

/** Inicia un ataque: decide crítico y true strike (como Dota, al lanzarlo). */
export function makeAttack(a: Unit, t: Unit, fake = false): AttackEvent {
  const ev: AttackEvent = {
    attacker: a, target: t,
    damage: a.s.dmgMin + a.w.rng() * (a.s.dmgMax - a.s.dmgMin) + a.s.dmgBonus,
    critMult: 1, trueStrike: false, missed: false, fake,
    distance: Math.hypot(t.x - a.x, t.y - a.y),
  };
  for (const m of a.hooks()) m.onAttackStart?.(m, ev);
  return ev;
}

/** Lanza el ataque: cuerpo a cuerpo impacta ya, a distancia crea proyectil. */
export function launchAttack(a: Unit, t: Unit, fake = false) {
  const ev = makeAttack(a, t, fake);
  // Atacar rompe la invisibilidad (el daño extra de Shadow Blade ya se sumó en makeAttack).
  for (const m of a.mods) if (m.data.breaksOnAttack) m.data.breakNow = true;
  if (a.melee || fake) { landAttack(ev); return; }
  a.w.addProjectile({
    kind: 'track', fx: 'attack:' + (a.hero?.key ?? a.name), source: a, target: t,
    x: a.x, y: a.y, speed: a.base.projSpeed, dodgeable: true,
    onHit: () => { landAttack(ev); return true; },
  });
}

export function landAttack(ev: AttackEvent) {
  const a = ev.attacker as Unit, t = ev.target as Unit;
  if (!t.alive || t.has(ST.invulnerable)) return;
  if (t.has(ST.ethereal)) return;
  const w = t.w;
  if (!ev.trueStrike && (w.rng() < t.s.evasion || w.rng() < a.s.missChance)) {
    ev.missed = true;
    w.emit({ n: 'miss', x: t.x, y: t.y, u: t.id });
    for (const m of t.hooks()) m.onAttacked?.(m, ev);
    return;
  }
  for (const m of a.hooks()) m.onAttackLanded?.(m, ev);
  for (const m of t.hooks()) m.onAttacked?.(m, ev);
  if (!t.alive) return;
  const crit = ev.critMult > 1;
  dealDamage({
    source: a, target: t, amount: ev.damage * ev.critMult, type: 'physical',
    ability: null, isAttack: true, crit,
  });
  if (a.melee) w.emit({ n: 'hit', x: t.x, y: t.y, u: t.id, u2: a.id });
}

export function respawnTime(level: number) {
  // Overthrow reaparece rápido: entre 5 y 20 s.
  return Math.min(20, 4 + level * 0.6);
}

export function kill(t: Unit, killer: Unit | null) {
  if (!t.alive) return;
  const w = t.w;
  t.alive = false;
  t.order = null; t.queue = []; t.path = [];
  if (t.cast) w.interruptCast(t, true);
  for (const m of t.hooks()) m.onDeath?.(m, killer);
  for (const u of w.list) {
    if (!u.alive && u !== t) continue;
    for (const m of u.hooks()) m.onAnyDeath?.(m, t, killer);
  }
  if (killer) for (const m of killer.hooks()) m.onKill?.(m, t);
  for (const m of [...t.mods]) if (!m.persistent) t.removeMod(m);
  w.emit({ n: 'death', x: t.x, y: t.y, u: t.id });

  const kh = creditHero(killer);
  if (t.kind === 'hero') {
    t.deaths++;
    t.respawnAt = w.time + Math.max(1, respawnTime(t.level) - t.s.respawnReduce);
    const assisters: Unit[] = [];
    for (const [id, at] of t.damagedBy) {
      const u = w.units.get(id);
      if (u && u !== kh && u.team !== t.team && w.time - at <= 15 && u.kind === 'hero') assisters.push(u);
    }
    t.damagedBy.clear();
    if (kh && kh.team !== t.team) {
      kh.kills++;
      kh.gold += 110 + 8 * t.level;
      for (const a of assisters) { a.assists++; a.gold += Math.round((40 + 4 * t.level) / Math.max(1, assisters.length) * 2); }
    }
    // XP: 40 + 13% de la XP de la víctima, repartida entre héroes enemigos cercanos.
    const xp = 40 + 0.13 * t.xp;
    const near = w.list.filter((u) => u.kind === 'hero' && u.alive && u.team !== t.team &&
      Math.hypot(u.x - t.x, u.y - t.y) <= 1500);
    if (kh && kh.team !== t.team && !near.includes(kh)) near.push(kh);
    for (const u of near) u.addXp(xp / Math.max(1, near.length));
    w.rules?.onHeroKilled(t, kh, assisters);
  } else if (t.kind === 'creep') {
    if (kh) { kh.gold += t.bountyGold; kh.lastHits++; w.emit({ n: 'gold', x: t.x, y: t.y, v: t.bountyGold, u: kh.id }); }
    const near = w.list.filter((u) => u.kind === 'hero' && u.alive && u.team !== t.team &&
      Math.hypot(u.x - t.x, u.y - t.y) <= 1500);
    for (const u of near) u.addXp(t.bountyXp / near.length);
    w.rules?.onCreepKilled?.(t, kh);
    w.removeLater(t, 1.5);
  } else {
    w.removeLater(t, t.kind === 'illusion' ? 0.3 : 1);
  }
}
