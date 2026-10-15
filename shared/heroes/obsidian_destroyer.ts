import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, isItem, manaCostOf, val } from '../sim/abilities';
import { damage, giveMana } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { barrierSpec } from './lib/a5';

/** Equilibrium: probabilidad de recuperar parte del maná gastado. */
function equilibrium(u: Unit, spent: number, attack: boolean) {
  const eq = u.abilities.find((x) => x.key === 'obsidian_destroyer_equilibrium');
  if (!eq || eq.level <= 0 || spent <= 0 || u.has(ST.broken)) return;
  if (u.w.rng() >= val(eq, 'proc_chance') / 100) return;
  giveMana(u, spent * val(eq, attack ? 'mana_restore_attack' : 'mana_restore') / 100);
  u.w.emit({ n: 'mana_restore', x: u.x, y: u.y, u: u.id });
}

// Orbe: daño puro según el maná actual; cuesta un % del maná actual.
defineAbility({
  key: 'obsidian_destroyer_arcane_orb', target: 'toggle', ai: { role: 'nuke' },
  passive: (a) => ({
    name: 'arcane_orb',
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit;
      if (!a.toggled || a.cd > 0 || ev.fake || u.kind !== 'hero' || u.has(ST.silenced)) return;
      const t = ev.target as Unit;
      if (t.team === u.team || t.kind === 'ward') return;
      const cost = u.mana * val(a, 'mana_cost_percentage') / 100;
      const bonus = u.mana * val(a, 'mana_pool_damage_pct') / 100 * a.upg.dmg;
      if (u.mana <= 1) return;
      u.mana -= cost;
      a.cd = cooldownOf(a);
      m.data.pending = m.data.pending ?? new WeakMap();
      m.data.pending.set(ev, bonus);
      equilibrium(u, cost, true);
    },
    onAttackLanded(m, ev) {
      const bonus = m.data.pending?.get(ev);
      if (!bonus) return;
      damage(ev.attacker as Unit, ev.target as Unit, bonus, 'pure', a);
    },
  }),
});

defineAbility({
  key: 'obsidian_destroyer_astral_imprisonment', target: 'unit', team: 'any', allowSelf: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const enemy = e.team !== u.team;
    const d = dur(a, 'prison_duration');
    // Roba capacidad de maná a héroes enemigos.
    if (enemy && e.kind === 'hero' && val(a, 'has_mana_steal') > 0) {
      const steal = e.s.maxMana * val(a, 'mana_capacity_steal') / 100;
      const md = val(a, 'mana_capacity_duration');
      e.addMod({ name: 'astral_mana_loss', duration: md, debuff: true, data: { multi: true }, props: { mana: -steal } }, u, a);
      u.addMod({ name: 'astral_mana_gain', duration: md, data: { multi: true }, props: { mana: steal } }, u, a);
      u.mana = Math.min(u.s.maxMana, u.mana + steal);
    }
    e.w.disjoint(e);
    if (e.cast) e.w.interruptCast(e, true);
    e.order = null;
    e.addMod({
      name: 'astral_prison', duration: d, debuff: enemy, purgable: false, fx: 'astral_prison',
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.stunned,
      // El daño llega justo después de salir (ya sin invulnerabilidad).
      onDestroy() { u.w.after(0, implode); },
    }, u, a);
    function implode() {
        const r = val(a, 'damage_radius');
        const list = r > 0 ? u.w.unitsIn(e.x, e.y, r, (v) => v.team !== u.team && u.w.targetable(v) && !v.has(ST.invulnerable)) : [];
        if (enemy && !list.includes(e)) list.push(e);
        u.w.emit({ n: 'astral_end', x: e.x, y: e.y, r: r || 100, t: u.team });
        for (const v of list) damage(u, v, dmg(a, 'damage'), 'magical', a);
    }
  },
});

defineAbility({
  key: 'obsidian_destroyer_objurgation', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  passive: (a) => ({
    name: 'objurgation_mana', props: { mana: val(a, 'bonus_mana') },
    // Scepter: impide bajar del umbral de vida una vez cada X segundos.
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (!hasScepter(u) || u.kind !== 'hero' || ev.amount <= 0) return;
      if ((a.data.autoAt ?? -1e9) + val(a, 'automatic_trigger_cd') > u.w.time) return;
      const thr = u.s.maxHp * val(a, 'automatic_trigger_threshold') / 100;
      if (u.hp - ev.amount >= thr) return;
      a.data.autoAt = u.w.time;
      ev.amount = Math.max(0, u.hp - thr);
      u.purge(true, false, true);
      u.addMod(barrierSpec('objurgation_auto', val(a, 'barrier_duration'),
        val(a, 'barrier_flat') + u.s.maxMana * val(a, 'mana_to_barrier') / 100, { purgable: false }), u, a);
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod(barrierSpec('objurgation', val(a, 'barrier_duration'),
      (val(a, 'barrier_flat') + u.s.maxMana * val(a, 'mana_to_barrier') / 100) * a.upg.dmg), u, a);
  },
});

defineAbility({
  key: 'obsidian_destroyer_equilibrium', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'equilibrium',
    props: () => {
      const u = a.owner as Unit;
      const ms = val(a, 'mana_as_ms');
      return ms > 0 ? { msFlat: u.mana * ms / 100 } : {};
    },
    onAbilityExecuted(m, ab) {
      const u = m.owner as Unit;
      if (isItem(ab) || ab.key === 'obsidian_destroyer_arcane_orb') return;
      equilibrium(u, manaCostOf(ab as AbilityInst), false);
    },
    onTick(m) {
      if (val(a, 'mana_as_ms') > 0 && (m.owner as Unit).w.tickN % 15 === 0) (m.owner as Unit).refreshStats();
    },
  }),
});

defineAbility({
  key: 'obsidian_destroyer_sanity_eclipse', target: 'point', ult: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  castRange: (a) => val(a, 'cast_range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'sanity_eclipse', x: t.x, y: t.y, r, t: u.team });
    // También alcanza a unidades dentro de Astral Imprisonment.
    const list = u.w.unitsIn(t.x, t.y, r, (v) => v.team !== u.team && v.alive &&
      (!!v.findMod('astral_prison') || u.w.targetable(v)) && v.kind !== 'fountain' && v.kind !== 'throne' && v.kind !== 'orb' && v.kind !== 'kobold');
    for (const e of list) {
      const diff = Math.max(0, u.mana - e.mana);
      const amount = dmg(a, 'base_damage') + diff * val(a, 'damage_multiplier');
      damage(u, e, amount, 'magical', a);
    }
  },
});

defineHero('obsidian_destroyer', ['obsidian_destroyer_arcane_orb', 'obsidian_destroyer_astral_imprisonment', 'obsidian_destroyer_objurgation', 'obsidian_destroyer_equilibrium', 'obsidian_destroyer_sanity_eclipse'], {
  build: ['null_talisman', 'power_treads', 'witch_blade', 'black_king_bar', 'ultimate_scepter', 'sheepstick', 'shivas_guard'],
});
