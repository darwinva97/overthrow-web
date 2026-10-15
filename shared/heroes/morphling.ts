import { ABILITIES } from '../data';
import { HERO_KITS, abilityImpl, castRangeOf, defineAbility, defineHero, dmg, makeAbility, refreshPassive, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, push, stun } from './util';
import { gate } from './lib/a5';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'morphling_waveform', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const d = Math.min(castRangeOf(a), Math.hypot(t.x - u.x, t.y - u.y) || castRangeOf(a));
    const hit = new Set<number>();
    const w = val(a, 'width');
    u.w.disjoint(u);
    u.purge(false, false);
    const step = () => {
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, w / 2)) {
        if (hit.has(e.id) || e.kind === 'ward') continue;
        hit.add(e.id);
        damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
        // Talento: aplica el ataque.
        if (val(a, 'process_procs') > 0 && e.alive) { const ev = makeAttack(u, e, true); ev.trueStrike = true; landAttack(ev); }
      }
    };
    dash(u, u.x + dx * d, u.y + dy * d, val(a, 'speed'), a, {
      name: 'waveform', states: ST.invulnerable | ST.untargetable, onStep: step, onArrive: step,
    });
  },
});

/** Proporción agilidad/fuerza (0 = fuerza ≥ 1,5× agilidad … 1 = agilidad ≥ 1,5× fuerza). */
function agiFactor(u: Unit) {
  const agi = Math.max(1, u.s.agi), str = Math.max(1, u.s.str);
  return Math.max(0, Math.min(1, (agi / str - 1) / 0.5));
}
function strFactor(u: Unit) {
  const agi = Math.max(1, u.s.agi), str = Math.max(1, u.s.str);
  return Math.max(0, Math.min(1, (str / agi - 1) / 0.5));
}

defineAbility({
  key: 'morphling_adaptive_strike_agi', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'adaptive_strike', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        const mult = val(a, 'damage_min') + (val(a, 'damage_max') - val(a, 'damage_min')) * agiFactor(u);
        damage(u, e, dmg(a, 'damage_base') + u.s.agi * mult * a.upg.dmg, 'magical', a);
        if (!e.alive) return true;
        const sf = strFactor(u);
        const st = val(a, 'stun_min') + (val(a, 'stun_max') - val(a, 'stun_min')) * sf;
        const kb = val(a, 'knockback_min') + (val(a, 'knockback_max') - val(a, 'knockback_min')) * sf;
        push(e, e.x - u.x, e.y - u.y, kb, val(a, 'knockback_duration'), u, a, 'adaptive_strike_push');
        stun(u, e, st, a);
        return true;
      },
    });
  },
});

/** Attribute Shift: pasa puntos de un atributo base al otro mientras está activo. */
function shiftAbility(key: string, toAgi: boolean) {
  defineAbility({
    key, target: 'toggle', ...(toAgi ? {} : { ai: { role: 'buff' } }),
    onToggle(a, on) {
      const u = a.owner as Unit;
      if (!on) { u.removeModsByName('attribute_shift'); return; }
      const other = ability(u, toAgi ? 'morphling_morph_str' : 'morphling_morph_agi');
      if (other?.toggled) { other.toggled = false; }
      u.removeModsByName('attribute_shift');
      const ptsPerTick = val(a, 'points_per_tick');
      u.addMod({
        name: 'attribute_shift', fx: toAgi ? 'morph_agi' : 'morph_str', interval: ptsPerTick / val(a, 'morph_rate'),
        onInterval(m) {
          // Gasta maná por segundo (el Shard lo reduce) y no baja un atributo de 1.
          const cost = val(a, 'mana_cost') * m.interval!;
          const from = toAgi ? u.baseAttr('str') : u.baseAttr('agi');
          if (u.mana < cost || from <= 1 + ptsPerTick) { a.toggled = false; u.removeMod(m); return; }
          u.mana -= cost;
          if (toAgi) { u.permStr -= ptsPerTick; u.permAgi += ptsPerTick; } else { u.permAgi -= ptsPerTick; u.permStr += ptsPerTick; }
          u.refreshStats();
        },
      }, u, a);
    },
  });
}
shiftAbility('morphling_morph_agi', true);
shiftAbility('morphling_morph_str', false);

// ---------------- Morph ----------------

interface MorphState {
  target: string; levels: number[]; until: number;
  saved: AbilityInst[] | null; base: Unit['base'] | null;
  /** Copias de las habilidades del objetivo (conservan su enfriamiento al alternar). */
  copies: (AbilityInst | null)[] | null;
}

/** Habilidades básicas que copia: ni definitiva, ni innata, ni de Aghanim's, ni sub-habilidades. */
function basicKeys(heroKey: string): string[] {
  return (HERO_KITS[heroKey] ?? []).filter((k) => {
    const impl = abilityImpl(k), def = ABILITIES[k];
    if (!impl || !def) return false;
    return !(impl.ult || def.ult || impl.innate || def.innate || impl.requires || def.grantedBy ||
      impl.levelWith !== undefined || impl.sub || impl.hidden);
  }).slice(0, 4);
}

function morphInto(u: Unit, st: MorphState) {
  if (st.saved) return;
  for (const k of ['morphling_morph_agi', 'morphling_morph_str']) {
    const x = ability(u, k);
    if (x?.toggled) { x.toggled = false; x.impl.onToggle?.(x, false); }
  }
  const keys = basicKeys(st.target);
  st.saved = u.abilities.slice(0, 4);
  st.saved.forEach((x) => { if (x.passiveMod) { u.removeMod(x.passiveMod); x.passiveMod = null; } });
  st.copies ??= keys.map((k, i) => {
    const c = makeAbility(u, k, i);
    if (c) c.level = Math.max(1, st.levels[i] ?? 1);
    return c;
  });
  st.copies.forEach((c, i) => {
    if (!c) return;
    u.abilities[i] = c;
    refreshPassive(c);
  });
  st.base = u.base;
  const src = u.w.list.find((x) => x.hero?.key === st.target);
  if (src) u.base = { ...u.base, range: src.base.range, melee: src.base.melee, projSpeed: src.base.projSpeed, attackPoint: src.base.attackPoint };
  u.refreshStats();
  u.w.emit({ n: 'morph', x: u.x, y: u.y, u: u.id });
}

function morphBack(u: Unit, st: MorphState) {
  if (!st.saved) return;
  st.saved.forEach((x, i) => {
    const cur = u.abilities[i];
    if (cur?.passiveMod) { u.removeMod(cur.passiveMod); cur.passiveMod = null; }
    u.abilities[i] = x;
    refreshPassive(x);
  });
  st.saved = null;
  if (st.base) u.base = st.base;
  st.base = null;
  u.refreshStats();
  u.w.emit({ n: 'morph', x: u.x, y: u.y, u: u.id });
}

defineAbility({
  key: 'morphling_replicate', target: 'unit', team: 'any', ult: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e.hero || e.hero.key === 'morphling') return;
    const src = e.kind === 'illusion' ? (e.owner as Unit) ?? e : e;
    const prev: MorphState | undefined = u.data_morph;
    if (prev) morphBack(u, prev);
    const keys = basicKeys(e.hero.key);
    const levels = keys.map((k) => src.abilities.find((x) => x.key === k)?.level ?? 1);
    const st: MorphState = { target: e.hero.key, levels, until: u.w.time + val(a, 'duration'), saved: null, base: null, copies: null };
    u.data_morph = st;
    morphInto(u, st);
    u.addMod({
      name: 'replicate', duration: val(a, 'duration'), fx: 'replicate',
      onDestroy() { morphBack(u, st); if (u.data_morph === st) u.data_morph = null; },
    }, u, a);
  },
});

// Cambia entre su forma y la copiada mientras dure Morph.
defineAbility({
  key: 'morphling_morph_replicate', target: 'none', levelWith: 4, ai: { role: 'summon', selfRadius: 900 },
  hidden: (a) => !(a.owner as Unit).data_morph,
  passive: gate((a) => !!(a.owner as Unit).data_morph),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const st: MorphState | undefined = u.data_morph;
    if (!st) return;
    if (st.saved) morphBack(u, st); else morphInto(u, st);
  },
});

// Innata (aproximación): bonus según qué atributo domina.
defineAbility({
  key: 'morphling_ebb_and_flow', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'ebb_and_flow', interval: 0.5,
    props: () => {
      const u = a.owner as Unit;
      if (!u.s) return {};
      const fa = agiFactor(u), fs = strFactor(u);
      return {
        attackRange: val(a, 'attack_range_per_agi') * 4 * fa,
        msFlat: val(a, 'move_speed_per_agi') * 2 * fa,
        castRange: val(a, 'cast_range_per_str') * 4 * fs,
        slowResist: val(a, 'slow_resist_per_str') / 100 * fs,
      };
    },
    onInterval() { (a.owner as Unit).refreshStats(); },
  }),
});

defineHero('morphling', ['morphling_waveform', 'morphling_adaptive_strike_agi', 'morphling_morph_agi', 'morphling_morph_str', 'morphling_replicate', 'morphling_morph_replicate', 'morphling_ebb_and_flow'], {
  build: ['wraith_band', 'power_treads', 'yasha', 'manta', 'black_king_bar', 'skadi', 'butterfly'],
});
