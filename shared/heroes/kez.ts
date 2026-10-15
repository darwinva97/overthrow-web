// Kez: alterna entre Katana (huecos 0-2 y la ulti Raptor Dance) y Sai (huecos 5-7 y Raven's Veil).
// Las habilidades de cada arma se ocultan según el arma activa sin reordenar u.abilities: la
// visible se aprende y la oculta la sigue con levelWith (se intercambian al cambiar de arma).
import {
  abilityImpl, cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, isItem, syncAutoLevels, val,
} from '../sim/abilities';
import { damage, heal, landAttack, launchAttack, makeAttack } from '../sim/combat';
import type { AbilityImpl, AbilityInst, AttackEvent, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, distToSegment, heroOf, inCone, nearestEnemyHero, ready } from './lib/a4';
import { castDir, dash, debuff, silence, slow, stun } from './util';

/** Parejas Katana ↔ Sai por hueco del kit. */
const PAIRS: [number, number][] = [[0, 5], [1, 6], [2, 7], [4, 8]];
const partnerOf = (slot: number) => {
  for (const [k, s] of PAIRS) { if (k === slot) return s; if (s === slot) return k; }
  return -1;
};

const switchOf = (u: Unit) => heroOf(u).abilities.find((x) => x.key === 'kez_switch_weapons');
/** ¿Lleva los Sai? (las ilusiones miran al héroe). */
export const isSai = (u: Unit) => !!switchOf(u)?.data.sai;

/** Vista por instancia de la habilidad: oculta/visible y a quién sigue de nivel. */
function view(a: AbilityInst | undefined, levelWith: number | undefined, hidden: boolean) {
  if (!a) return;
  if (!a.data.view) { a.impl = Object.create(a.impl) as AbilityImpl; a.data.view = true; }
  const base = (abilityImpl(a.key) ?? Object.getPrototypeOf(a.impl)) as AbilityImpl;
  const v = a.impl as any;
  v.levelWith = levelWith;
  v.hidden = hidden ? base.hidden : undefined;
  v.ai = hidden ? undefined : base.ai;
}

function applyView(u: Unit, sai: boolean) {
  for (const [k, s] of PAIRS) {
    view(u.abilities[k], sai ? s : undefined, sai);
    view(u.abilities[s], sai ? undefined : k, !sai);
  }
  syncAutoLevels(u);
}

function setWeapon(u: Unit, sw: AbilityInst, sai: boolean) {
  sw.data.sai = sai;
  u.base.range = val(sw, sai ? 'sai_attack_range' : 'katana_attack_range');
  u.base.bat = val(sw, sai ? 'sai_base_attack_time' : 'katana_base_attack_time');
  applyView(u, sai);
  u.refreshStats();
}

/** Bonus del primer golpe o habilidad tras cambiar a Katana (se consume). */
function swapMult(u: Unit): number {
  const h = heroOf(u);
  const m = h.findMod('kez_katana_swap');
  const sw = switchOf(u);
  if (!m || !sw) return 1;
  h.removeMod(m);
  return 1 + val(sw, 'katana_swap_bonus_damage') / 100;
}

/** Ataque falso con daño extra (Echo Slash, Talon Toss…). */
function strikeAttack(u: Unit, t: Unit, extra: number, fixed?: number) {
  const ev = makeAttack(u, t, true);
  if (fixed !== undefined) { ev.damage = fixed; ev.critMult = 1; }
  ev.damage += extra;
  landAttack(ev);
  return ev;
}

// ---------------- Katana ----------------

const katanaHidden = (a: AbilityInst) => isSai(a.owner as Unit);
const saiHidden = (a: AbilityInst) => !isSai(a.owner as Unit);

defineAbility({
  key: 'kez_echo_slash', target: 'none', hidden: katanaHidden, ai: { role: 'aoe', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const dx = Math.cos(u.facing), dy = Math.sin(u.facing);
    const x0 = u.x, y0 = u.y;
    const len = val(a, 'katana_distance'), r = val(a, 'katana_radius');
    const x1 = x0 + dx * len, y1 = y0 + dy * len;
    const bonus = swapMult(u);
    const strike = () => {
      if (!u.alive) return;
      u.w.emit({ n: 'echo_slash', x: x0, y: y0, x2: x1, y2: y1, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + r)) {
        if (e.kind === 'ward' || distToSegment(e.x, e.y, x0, y0, x1, y1) > r + e.radius) continue;
        const extra = dmg(a, 'katana_echo_damage') + (e.isHeroLike ? dmg(a, 'echo_hero_damage') : 0);
        const ev = makeAttack(u, e, true);
        ev.damage = (ev.damage + extra) * bonus;
        landAttack(ev);
        slow(u, e, a, 'kez_echo_tag', val(a, 'tag_slow_duration'), val(a, 'tag_slow') / 100);
      }
    };
    strike();
    // Kez avanza un poco mientras corta.
    const travel = val(a, 'travel_distance');
    dash(u, u.x + dx * travel, u.y + dy * travel, travel / 0.2, a, { name: 'kez_echo_dash' });
    const n = val(a, 'katana_strikes'), every = val(a, 'strike_interval');
    for (let i = 1; i < n; i++) u.w.after(every * i, strike);
  },
});

defineAbility({
  key: 'kez_grappling_claw', target: 'unit', hidden: katanaHidden, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (u.has(ST.rooted)) return;
    u.w.addProjectile({
      kind: 'track', fx: 'kez_claw', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'),
      onHit() {
        if (!u.alive || Math.hypot(e.x - u.x, e.y - u.y) > val(a, 'max_distance_break')) return true;
        if (e.team !== u.team) slow(u, e, a, 'kez_claw_slow', dur(a, 'debuff_duration'), val(a, 'katana_ms_slow_pct') / 100);
        const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
        const land = val(a, 'land_distance') + e.radius;
        const tx = e.x - (e.x - u.x) / d * land, ty = e.y - (e.y - u.y) / d * land;
        dash(u, tx, ty, val(a, 'grapple_speed'), a, {
          name: 'kez_grapple',
          onArrive: () => {
            if (!u.alive || !e.alive || !u.w.targetable(e) || Math.hypot(e.x - u.x, e.y - u.y) > land + 200) return;
            launchAttack(u, e, true);
            if (u.isBot) u.w.issueOrder(u, { type: 'attack', target: e.id });
          },
        });
        return true;
      },
    });
  },
});

/** Sangrado de Kazurai Katana: una sola instancia por objetivo con la lista de golpes. */
function addBleed(u: Unit, t: Unit, a: AbilityInst, dps: number) {
  if (dps <= 0 || !t.alive) return;
  const h = heroOf(u);
  let m = t.findMod('kazurai_bleed', h);
  if (!m) {
    const spec: ModSpec = {
      name: 'kazurai_bleed', duration: Infinity, interval: 0.5, fx: 'bleed', data: { list: [] as { dps: number; until: number }[] },
      onInterval(mm) {
        const tg = mm.owner as Unit;
        const now = tg.w.time;
        mm.data.list = mm.data.list.filter((x: any) => x.until > now);
        const sum = mm.data.list.reduce((s: number, x: any) => s + x.dps, 0);
        mm.stacks = Math.round(sum);
        if (!mm.data.list.length) { tg.removeMod(mm); return; }
        const dealt = damage(h, tg, sum * 0.5, 'physical', a, { noProc: true });
        bleedLifesteal(h, tg, a, dealt);
      },
    };
    m = debuff(h, t, a, spec) ?? undefined;
    if (!m) return;
  }
  const sum = m.data.list.reduce((s: number, x: any) => s + x.dps, 0);
  const add = Math.min(dps, Math.max(0, val(a, 'max_stacks') - sum));
  if (add > 0) m.data.list.push({ dps: add, until: u.w.time + dur(a, 'katana_bleed_duration') });
  m.stacks = Math.round(sum + add);
}

/** Robo de vida del sangrado (enlazado al Shard en los datos). */
function bleedLifesteal(h: Unit, t: Unit, a: AbilityInst, dealt: number) {
  const ls = val(a, 'lifesteal_pct') / 100;
  if (ls <= 0 || dealt <= 0) return;
  const creep = t.isHeroLike ? 1 : 1 - val(a, 'creep_lifesteal_reduction_pct') / 100;
  heal(h, dealt * ls * creep, h, true);
}

defineAbility({
  key: 'kez_kazurai_katana', target: 'unit', hidden: katanaHidden, reflectable: true, ai: { role: 'nuke' },
  castPoint: () => 0,
  passive: (a) => ({
    name: 'kazurai_katana',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (isSai(u) || t.team === u.team || t.kind === 'ward' || ev.missed) return;
      addBleed(u, t, a, ev.damage * ev.critMult * val(a, 'katana_bleed_attack_damage_pct') / 100);
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    launchAttack(u, e, true);
    // Empala: no se mueve ni gira (raíz) y el sangrado revienta parte de lo que le queda.
    debuff(u, e, a, { name: 'kez_impale', duration: val(a, 'impale_duration'), states: ST.rooted | ST.disarmed, fx: 'root' });
    const m = e.findMod('kazurai_bleed', heroOf(u));
    if (!m) return;
    const now = u.w.time;
    const frac = Math.min(1, val(a, 'bleed_as_rupture_pct') / 100);
    let burst = 0;
    for (const x of m.data.list) { burst += x.dps * Math.max(0, x.until - now) * frac; x.dps *= 1 - frac; }
    m.data.list = m.data.list.filter((x: any) => x.dps > 0.01);
    if (burst > 0) bleedLifesteal(u, e, a, damage(u, e, burst * swapMult(u), 'physical', a));
  },
});

/** Bot: cambia de arma en pelea cuando el arma actual no tiene nada listo o de vez en cuando. */
function switchBrain(a: AbilityInst): ModSpec {
  return botBrain(a, (u) => {
    const e = nearestEnemyHero(u, 900);
    if (!e) return null;
    const mine = PAIRS.map(([k, s]) => u.abilities[a.data.sai ? s : k]);
    const other = PAIRS.map(([k, s]) => u.abilities[a.data.sai ? k : s]);
    const anyMine = mine.some((x) => x && x.level > 0 && ready(x));
    const anyOther = other.some((x) => x && x.level > 0 && x.cd <= 0);
    if ((!anyMine && anyOther) || u.w.rng() < 0.12) return { x: u.x, y: u.y };
    return null;
  }, 0.5);
}

defineAbility({
  key: 'kez_switch_weapons', target: 'none', innate: true,
  passive: (a) => ({
    ...switchBrain(a),
    name: 'kez_weapon',
    props: () => (a.data.sai ? {} : { damage: val(a, 'katana_agility_bonus_base_damage') }),
    onCreated(m) { setWeapon(m.owner as Unit, a, !!a.data.sai); },
    // Enfriamiento compartido entre la habilidad y su pareja del otro arma (y Scepter).
    onAbilityExecuted(_m, ab) {
      if (isItem(ab)) return;
      const u = a.owner as Unit;
      const p = partnerOf(ab.slot);
      if (p < 0 || u.abilities[ab.slot] !== ab) return;
      const other = u.abilities[p];
      if (hasScepter(u)) {
        a.cd = 0;
        const fresh = u.w.time - (a.data.switchedAt ?? -99) <= val(a, 'scepter_cooldown_timer') && !a.data.used;
        a.data.used = true;
        if (fresh || other.cd > 0) return;
      }
      if (other) other.cd = Math.max(other.cd, cooldownOf(other));
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const sai = !a.data.sai;
    setWeapon(u, a, sai);
    a.data.switchedAt = u.w.time;
    a.data.used = false;
    u.w.emit({ n: 'kez_switch', x: u.x, y: u.y, u: u.id, v: sai ? 1 : 0 });
    if (sai) {
      u.removeModsByName('kez_katana_swap');
      u.addMod({ name: 'kez_sai_swap', duration: dur(a, 'sai_swap_duration'), fx: 'haste',
        props: { msPct: val(a, 'sai_swap_bonus_movement_speed') / 100 } }, u, a);
    } else {
      u.addMod({
        name: 'kez_katana_swap', duration: Infinity,
        onAttackStart(m, ev) {
          if (ev.fake) return;
          ev.damage *= 1 + val(a, 'katana_swap_bonus_damage') / 100;
          (m.owner as Unit).removeMod(m);
        },
      }, u, a);
    }
  },
});

defineAbility({
  key: 'kez_raptor_dance', target: 'none', ult: true, hidden: katanaHidden, ai: { role: 'aoe', selfRadius: 380 },
  castPoint: () => 0,
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const windup = val(a, 'abilitycastpoint');
    if (val(a, 'basic_dispel')) u.purge(true, false);
    if (val(a, 'hard_dispel')) u.purge(true, false, true);
    u.w.disjoint(u);
    u.order = null; u.atk.phase = 0;
    u.addMod({ name: 'raptor_invuln', duration: val(a, 'invuln_period'), states: ST.invulnerable }, u, a);
    u.addMod({ name: 'raptor_dance', duration: windup, states: ST.busy | ST.disarmed, fx: 'raptor_dance' }, u, a);
    const bonus = swapMult(u);
    u.w.after(windup, () => {
      if (!u.alive || u.has(ST.stunned) || u.has(ST.hexed)) return;
      const n = val(a, 'strikes'), every = val(a, 'strike_interval');
      for (let i = 0; i < n; i++) {
        u.w.after(every * i, () => {
          if (!u.alive) return;
          const r = val(a, 'radius');
          u.w.emit({ n: 'raptor_slash', x: u.x, y: u.y, r, t: u.team });
          for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
            if (e.kind === 'ward') continue;
            const amt = (dmg(a, 'base_damage') + e.s.maxHp * val(a, 'max_health_damage_pct') / 100) * bonus;
            const dealt = damage(u, e, amt, 'pure', a);
            const ls = (e.kind === 'illusion' ? val(a, 'illusion_lifesteal_pct') : val(a, 'lifesteal_pct')) / 100;
            heal(u, dealt * ls, u, true);
          }
        });
      }
    });
  },
});

// ---------------- Sai ----------------

defineAbility({
  key: 'kez_falcon_rush', target: 'none', hidden: saiHidden, levelWith: 0, ai: { role: 'buff' },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'falcon_rush', duration: dur(a, 'duration'), fx: 'falcon_rush', states: ST.noCollision,
      props: { slowResist: val(a, 'slow_resist') / 100, attackSpeed: val(a, 'bonus_attack_speed') },
      onTick(_m, dt) {
        // Se lanza hacia el objetivo de ataque si está dentro del alcance de la embestida.
        const o = u.order;
        if (!o || o.type !== 'attack' || u.has(ST.rooted) || u.has(ST.stunned) || u.cast) return;
        const t = u.w.units.get(o.target);
        if (!t || !t.alive) return;
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        const reach = u.s.attackRange + u.radius + t.radius;
        if (d <= reach || d > val(a, 'rush_range')) return;
        const step = Math.max(0, val(a, 'rush_speed') - u.s.ms) * dt;
        u.w.forceMove(u, u.x + (t.x - u.x) / d * step, u.y + (t.y - u.y) / d * step);
      },
      onAttackLanded(_m, ev) {
        if (ev.fake || ev.missed) return;
        const t = ev.target as Unit;
        if (t.team === u.team || Math.hypot(t.x - u.x, t.y - u.y) > val(a, 'break_range')) return;
        // Ataque eco: daño fijo, con menos probabilidad de efectos de azar.
        u.w.after(0.15, () => {
          if (!u.alive || !t.alive || !u.w.targetable(t)) return;
          u.data_kezEcho = true;
          const e2 = makeAttack(u, t, true);
          u.data_kezEcho = false;
          e2.damage = dmg(a, 'base_echo_damage');
          landAttack(e2);
        });
      },
    }, u, a);
  },
});

defineAbility({
  key: 'kez_talon_toss', target: 'unit', hidden: saiHidden, levelWith: 1, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'talon_toss', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: true,
      onHit() {
        if (!e.alive) return true;
        strikeAttack(u, e, 0, dmg(a, 'damage'));
        silence(u, e, dur(a, 'silence_duration'), a, 'talon_toss_silence');
        return true;
      },
    });
  },
});

const shodoOf = (u: Unit) => heroOf(u).abilities.find((x) => x.key === 'kez_shodo_sai');

/** Marca de Kez: el siguiente ataque con Sai es crítico seguro y aturde. */
function applyMark(u: Unit, t: Unit, parry: boolean) {
  const s = shodoOf(u);
  if (!s || !t.isHeroLike && t.kind !== 'creep') return;
  const m = debuff(heroOf(u), t, s, { name: 'kez_mark', duration: dur(s, 'vuln_duration'), fx: 'kez_mark', data: { parry } });
  if (m) m.data.parry = m.data.parry || parry;
}

/** Bot: bloquea cuando un héroe enemigo le está pegando de cerca. */
function parryBrain(a: AbilityInst): ModSpec {
  return botBrain(a, (u) => {
    if (!isSai(u) || u.findMod('shodo_sai_parry')) return null;
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, 600, { heroes: true })) {
      if (e.kind === 'hero' && (e.atk.target === u.id || (e.order?.type === 'attack' && e.order.target === u.id))) return { x: e.x, y: e.y };
    }
    return null;
  }, 0.3);
}

defineAbility({
  key: 'kez_shodo_sai', target: 'point', hidden: saiHidden, levelWith: 2,
  passive: (a) => ({
    ...parryBrain(a),
    name: 'shodo_sai',
    onAttackStart(_m, ev: AttackEvent) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (!isSai(u) || t.team === u.team) return;
      const mk = t.findMod('kez_mark', heroOf(u));
      if (mk) {
        const pb = mk.data.parry ? val(a, 'parry_bonus_crit') : 0;
        ev.critMult = Math.max(ev.critMult, (val(a, 'base_crit_pct') + pb) / 100);
        (ev as any).kezMark = mk;
        return;
      }
      const chance = val(a, 'sai_proc_vuln_chance') / 100 * (u.data_kezEcho ? 1 - val(abilityOf(u, 'kez_falcon_rush'), 'echo_proc_chance_reduction') / 100 : 1);
      if (u.w.rng() < chance) ev.critMult = Math.max(ev.critMult, val(a, 'base_crit_pct') / 100);
    },
    onAttackLanded(_m, ev) {
      const mk = (ev as any).kezMark;
      if (!mk || ev.missed) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const extra = mk.data.parry ? val(a, 'parry_bonus_stun_duration') : 0;
      t.removeMod(mk);
      stun(heroOf(u), t, val(a, 'stun_duration') + extra, a);
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const face = Math.atan2(dy, dx);
    const half = val(a, 'forward_angle') / 2;
    const hit = new Set<number>();
    u.facing = face;
    u.addMod({
      name: 'shodo_sai_parry', duration: dur(a, 'parry_duration'), fx: 'parry', states: ST.disarmed,
      purgable: true, data: { strongPurgable: true, born: u.w.time },
      props: { msPct: -val(a, 'speed_penalty') / 100 },
      onTick(m) {
        u.facing = face;
        // Bot: cancela si ya no hay nadie delante.
        if (u.isBot && u.w.time - m.data.born > 0.5) {
          const front = u.w.enemiesIn(u.team, u.x, u.y, 700, { heroes: true })
            .some((e) => inCone(u.x, u.y, dx, dy, e.x, e.y, 700, half));
          const c = u.abilities.find((x) => x.key === 'kez_shodo_sai_parry_cancel');
          if (!front && c && ready(c)) u.w.issueOrder(u, { type: 'cast', slot: c.slot });
        }
      },
      onIncomingDamage(_m, ev) {
        const s = ev.source as Unit | null;
        if (!ev.isAttack || !s || s.team === u.team) return;
        if (!inCone(u.x, u.y, dx, dy, s.x, s.y, 99999, half)) return;
        ev.amount = 0;
        u.w.emit({ n: 'parry', x: u.x, y: u.y, u: u.id, u2: s.id });
        if (val(a, 'parry_only_heroes') && s.kind !== 'hero') return;
        if (hit.has(s.id)) return;
        hit.add(s.id);
        stun(u, s, val(a, 'parry_stun_duration'), a);
        applyMark(u, s, true);
      },
    }, u, a);
  },
});

const abilityOf = (u: Unit, key: string) => heroOf(u).abilities.find((x) => x.key === key)!;

defineAbility({
  key: 'kez_ravens_veil', target: 'none', ult: true, hidden: saiHidden, levelWith: 4, ai: { role: 'disable', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (val(a, 'basic_dispel')) u.purge(true, false);
    const r = val(a, 'blast_radius'), speed = val(a, 'blast_speed');
    u.w.emit({ n: 'ravens_veil', x: u.x, y: u.y, r, t: u.team });
    const x0 = u.x, y0 = u.y;
    for (const e of u.w.enemiesIn(u.team, x0, y0, r, { heroes: !!val(a, 'mark_only_heroes') })) {
      if (e.kind === 'ward') continue;
      u.w.after(Math.hypot(e.x - x0, e.y - y0) / speed, () => {
        if (!e.alive) return;
        applyMark(u, e, !!val(a, 'apply_parry_bonus'));
        // Ceguera: le recorta la visión (cantidad aproximada, no viene en los datos).
        const cut = e.s.vision * 0.6;
        debuff(u, e, a, { name: 'ravens_veil_blind', duration: dur(a, 'blind_duration'), fx: 'blind', props: { vision: -cut } });
      });
    }
    u.w.after(val(a, 'fade_delay'), () => {
      if (!u.alive) return;
      u.addMod({
        name: 'ravens_veil', duration: dur(a, 'buff_duration'), fx: 'invis', states: ST.invisible,
        props: { msPct: val(a, 'bonus_ms') / 100 }, data: { breaksOnAttack: true },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'kez_shodo_sai_parry_cancel', target: 'none', levelWith: 7,
  hidden: (a) => !(a.owner as Unit).findMod('shodo_sai_parry'),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('shodo_sai_parry'); },
});

defineHero('kez', [
  'kez_echo_slash', 'kez_grappling_claw', 'kez_kazurai_katana', 'kez_switch_weapons', 'kez_raptor_dance',
  'kez_falcon_rush', 'kez_talon_toss', 'kez_shodo_sai',
  // Ulti de los Sai y sub-habilidad de Shodo Sai (el dataset las mete entre los talentos).
  'kez_ravens_veil', 'kez_shodo_sai_parry_cancel',
], {
  build: ['wraith_band', 'power_treads', 'echo_sabre', 'desolator', 'black_king_bar', 'butterfly', 'satanic'],
});
