// Objetos neutrales (trinkets de 7.38+). Van al hueco neutral (u.items[9]) y funcionan como
// un hueco normal: pasiva con syncItemPassives y activa con { type: 'item', slot: 9 }.
// Los stats planos del dataset los aplica sim/items.ts; si el dataset pone en una clave de stat
// el valor de un efecto condicional (Dagger of Ristul, Duelist Gloves…) se compensa aquí.
import { lv } from '../data';
import { damage, giveMana, heal, landAttack, makeAttack } from '../sim/combat';
import { defineItem, itemLevel } from '../sim/items';
import { manaCostOf } from '../sim/abilities';
import { armorMult } from '../sim/unit';
import type { AbilityInst, ItemImpl, ItemInst, ModSpec, Props } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { canDebuff, dash, debuff, dot, push, slow, stun } from '../heroes/util';

const iv = (it: ItemInst, k: string) => lv(it.def.values[k], itemLevel(it.key));
const own = (it: ItemInst) => it.owner as Unit;
/** Las ilusiones no disparan procs de items. */
const real = (u: Unit) => u.kind === 'hero';
const isItemSrc = (a: unknown) => !!a && (a as ItemInst).isItem === true;
/** Compensa una resistencia multiplicativa (magicResist, evasion) que el dataset aplica siempre. */
const undoMult = (v: number) => -v / (1 - v);

function passiveItem(key: string, passive: (it: ItemInst) => Omit<ModSpec, 'name'>, extra: Partial<ItemImpl> = {}) {
  defineItem({ key, target: 'passive', passive: (it) => ({ name: 'p_' + key, ...passive(it) }), ...extra });
}

/** Barrera de daño de un tipo (física, mágica o cualquiera). */
function barrier(amount: number, type: 'physical' | 'magical' | 'any'): Partial<ModSpec> {
  return {
    data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (type !== 'any' && ev.type !== type)) return;
      const a = Math.min(m.data.left, ev.amount);
      m.data.left -= a; ev.amount -= a;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/** Potencia extra del encantamiento actual (Dormant Curio, Enchanter's Bauble). */
function enhancementBoost(key: string, pct: (it: ItemInst) => number) {
  passiveItem(key, (it) => ({
    props: (m) => {
      const enh = (m.owner as Unit).findMod('enhancement');
      const p = enh?.props && typeof enh.props !== 'function' ? enh.props : null;
      if (!p) return {};
      const out: Partial<Props> = {};
      for (const k in p) (out as any)[k] = (p as any)[k] * pct(it) / 100;
      return out;
    },
  }));
}

// ======================= Tier 1 =======================

// Chipped Vest: devuelve daño fijo a quien le ataca.
passiveItem('chipped_vest', (it) => ({
  onAttacked(m, ev) {
    const u = m.owner as Unit, a = ev.attacker as Unit;
    if (!real(u) || !a.alive || a.team === u.team) return;
    damage(u, a, a.isHeroLike ? iv(it, 'damage_return_hero') : iv(it, 'damage_return_creep'), 'physical', it,
      { noProc: true, data: { reflected: true } });
  },
}));

// Possessed Mask: cura fija por ataque.
passiveItem('possessed_mask', (it) => ({
  onAttackLanded(m) { heal(m.owner as Unit, iv(it, 'lifesteal'), null, true); },
}));

// Occult Bracelet: cargas de regeneración de maná al ser atacado (el dataset suma 0.4 fijos: se compensan).
passiveItem('occult_bracelet', (it) => ({
  data: { stacks: [] as number[] },
  props: (m) => ({ manaRegen: iv(it, 'mana_regen') * (m.data.stacks.length - 1) }),
  interval: 0.25,
  onInterval(m) {
    const u = m.owner as Unit, n = m.data.stacks.length;
    m.data.stacks = m.data.stacks.filter((t: number) => t > u.w.time);
    if (m.data.stacks.length !== n) u.refreshStats();
  },
  onAttacked(m, ev) {
    const u = m.owner as Unit;
    if ((ev.attacker as Unit).team === u.team) return;
    const s: number[] = m.data.stacks;
    s.push(u.w.time + iv(it, 'stack_duration'));
    s.sort((a, b) => b - a);
    if (s.length > iv(it, 'stack_limit')) s.length = iv(it, 'stack_limit');
    u.refreshStats();
  },
}));

// Dagger of Ristul: +25 de daño 8 s a cambio de vida (el dataset suma el daño siempre: se compensa).
defineItem({
  key: 'dagger_of_ristul', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  passive: (it) => ({ name: 'p_dagger_of_ristul', props: { damage: -iv(it, 'bonus_damage') } }),
  onSpellStart(it) {
    const u = own(it);
    u.hp = Math.max(1, u.hp - iv(it, '_hc'));
    u.addMod({ name: 'imbrue', duration: iv(it, 'duration'), fx: 'haste', props: { damage: iv(it, 'bonus_damage') } }, u, it);
  },
});

// Duelist Gloves: velocidad de ataque solo con héroes enemigos cerca.
passiveItem('duelist_gloves', (it) => ({
  data: { on: false },
  props: (m) => ({ attackSpeed: m.data.on ? 0 : -iv(it, 'bonus_attack_speed') }),
  interval: 0.25,
  onInterval(m) {
    const u = m.owner as Unit;
    const on = u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'radius'), { heroes: true }).some((e) => e.kind === 'hero');
    if (on !== m.data.on) { m.data.on = on; u.refreshStats(); }
  },
}));

// Polliwog Charm: regeneración a un aliado (el bonus en agua no existe en este mapa).
defineItem({
  key: 'polliwog_charm', target: 'unit', team: 'ally', allowSelf: true, castRange: (it) => iv(it, 'abilitycastrange'), ai: { role: 'heal' },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    e.addMod({ name: 'ribbit', duration: iv(it, 'duration'), fx: 'regen', props: { hpRegen: iv(it, 'regen_boost') } }, own(it), it);
  },
});

// Kobold Cup: velocidad a los aliados cercanos.
defineItem({
  key: 'kobold_cup', target: 'none', ai: { role: 'chase' },
  onSpellStart(it) {
    const u = own(it);
    u.w.emit({ n: 'aoe', x: u.x, y: u.y, r: iv(it, 'buff_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'buff_radius'))) {
      a.addMod({ name: 'one_for_the_road', duration: iv(it, 'buff_duration'), fx: 'haste', props: { msPct: iv(it, 'movespeed_pct') / 100 } }, u, it);
    }
  },
});

// Dormant Curio: en Overthrow no se fabrica; se aproxima como +30% de potencia del encantamiento actual.
enhancementBoost('dormant_curio', (it) => iv(it, 'item_potency'));

// Weighted Dice: daño base máximo +6 y se tira dos veces quedándose con la mayor.
passiveItem('weighted_dice', (it) => ({
  onAttackStart(m, ev) {
    const u = m.owner as Unit;
    const lo = u.s.dmgMin, hi = u.s.dmgMax;
    // Tirada original estimada a partir del daño ya calculado.
    const rolled = Math.min(hi, Math.max(lo, ev.damage - u.s.dmgBonus));
    let best = 0;
    for (let i = 0; i < iv(it, 'roll_count'); i++) best = Math.max(best, lo + u.w.rng() * (hi + iv(it, 'bonus_max_damage') - lo));
    ev.damage += Math.max(0, best - rolled);
  },
}));

// Ash Legion Shield: barrera física a las unidades aliadas de jugadores; el portador se ralentiza.
defineItem({
  key: 'ash_legion_shield', target: 'none', ai: { role: 'barrier', selfRadius: 800 },
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'shield_wall_slow', duration: iv(it, 'duration'), props: { msFlat: -iv(it, 'slow') } }, u, it);
    u.w.emit({ n: 'aoe', x: u.x, y: u.y, r: iv(it, 'block_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'block_radius'))) {
      if (!a.playerId) continue;
      a.addMod({ name: 'shield_wall', duration: iv(it, 'duration'), fx: 'barrier', ...barrier(iv(it, 'block_amount'), 'physical') }, u, it);
    }
  },
});

// Stonefeather Satchel: alterna plumas (+velocidad) y piedras (+armadura). El empuje no se modela.
defineItem({
  key: 'stonefeather_satchel', target: 'none', ai: { role: 'buff', selfRadius: 0 },
  passive: (it) => ({
    name: 'p_stonefeather_satchel',
    props: () => (it.mode === 0 ? { msFlat: iv(it, 'feather_movespeed') } : { armor: iv(it, 'rocks_armor') }),
  }),
  onSpellStart(it) { it.mode = it.mode ? 0 : 1; own(it).refreshStats(); },
});

// Forager's Kit: con el enfriamiento listo, quedarse 0,75 s junto a un árbol da 30 de oro.
// (Los árboles especiales, la flora y las setas no se modelan: siempre es la bolsa de oro.)
passiveItem('foragers_kit', (it) => ({
  data: { stand: 0, x: 0, y: 0 },
  interval: 0.25,
  onInterval(m) {
    const u = m.owner as Unit;
    if (!real(u) || !u.alive || it.cd > 0) return;
    const still = Math.hypot(u.x - m.data.x, u.y - m.data.y) < 5;
    m.data.x = u.x; m.data.y = u.y;
    if (!still || !u.w.nearestTree(u.x, u.y, iv(it, 'tree_radius'))) { m.data.stand = 0; return; }
    m.data.stand += 0.25;
    if (m.data.stand < iv(it, 'abilitychanneltime')) return;
    m.data.stand = 0;
    u.gold += iv(it, 'gold_amount');
    it.cd = it.def.cd || iv(it, '_cd');
    u.w.emit({ n: 'midas', x: u.x, y: u.y, v: iv(it, 'gold_amount'), u: u.id });
  },
}));

// ======================= Tier 2 =======================

passiveItem('poor_mans_shield', (it) => ({
  onIncomingDamage(m, ev) {
    const u = m.owner as Unit, s = ev.source as Unit | null;
    if (!ev.isAttack || ev.hpRemoval || !s) return;
    const chance = s.isHeroLike ? iv(it, 'block_chance_hero') : iv(it, 'block_chance');
    if (u.w.rng() >= chance / 100) return;
    const b = u.melee ? iv(it, 'damage_block_melee') : iv(it, 'damage_block_ranged');
    // El bloqueo va antes de la armadura: se convierte a daño ya reducido.
    ev.amount = Math.max(0, ev.amount - b * armorMult(u.s.armor));
  },
}));

defineItem({
  key: 'medallion_of_courage', target: 'unit', team: 'any', castRange: (it) => iv(it, 'abilitycastrange'), reflectable: true,
  ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    if (!e || e === u) { it.cd = 0; u.mana += it.def.mc; u.w.error(u, 'No se puede lanzar sobre uno mismo'); return; }
    if (e.team === u.team) {
      e.addMod({ name: 'medallion_ally', duration: iv(it, 'duration'), fx: 'buff', props: { armor: iv(it, 'ally_armor') } }, u, it);
    } else {
      debuff(u, e, it, { name: 'medallion_enemy', duration: iv(it, 'duration'), fx: 'corruption', props: { armor: iv(it, 'enemy_armor') } });
    }
  },
});

defineItem({
  key: 'essence_ring', target: 'none', ai: { role: 'heal' },
  onSpellStart(it) {
    const u = own(it);
    const before = u.hp;
    u.addMod({ name: 'essence_ring', duration: iv(it, 'health_gain_duration'), fx: 'regen', props: { hp: iv(it, 'health_gain') } }, u, it);
    u.hp = Math.min(u.s.maxHp, before + iv(it, 'health_gain'));
  },
});

// Tumbler's Toy / Pogo Stick: salto hacia delante; se desactiva 3 s tras recibir daño de jugador.
defineItem({
  key: 'pogo_stick', target: 'none', ai: { role: 'escape' },
  check: (it) => (own(it).w.time - own(it).lastHeroDamageAt < 3 ? 'Desactivado por daño' : null),
  onSpellStart(it) {
    const u = own(it);
    if (u.has(ST.rooted)) { it.cd = 0; return; }
    const d = iv(it, 'leap_distance');
    dash(u, u.x + Math.cos(u.facing) * d, u.y + Math.sin(u.facing) * d, iv(it, 'leap_speed'), it, { name: 'vault', states: ST.flying });
  },
});

// Seeds of Serenity: zona que regenera a los aliados (8 + 25% de la regeneración del lanzador).
defineItem({
  key: 'seeds_of_serenity', target: 'point', castRange: (it) => iv(it, 'abilitycastrange'), ai: { role: 'heal' },
  onSpellStart(it, t) {
    const u = own(it);
    const regen = iv(it, 'aura_health_regen') + u.s.hpRegen * iv(it, 'aura_health_regen_pct') / 100;
    const r = iv(it, 'radius');
    u.w.addZone({
      fx: 'seeds_of_serenity', x: t.x, y: t.y, r, team: u.team, interval: 0.25, duration: iv(it, 'duration'),
      onInterval(z) {
        for (const a of u.w.alliesIn(z.team, z.x, z.y, z.r)) a.addMod({ name: 'verdurous_dale', duration: 0.5, props: { hpRegen: regen } }, u, it);
      },
    });
  },
});

// Defiant Shell: al ser atacado contraataca al 80% (enfriamiento propio).
passiveItem('defiant_shell', (it) => ({
  onAttacked(m, ev) {
    const u = m.owner as Unit, a = ev.attacker as Unit;
    if (!real(u) || it.cd > 0 || ev.fake || !a.alive || a.team === u.team || u.has(ST.stunned | ST.disarmed | ST.hexed)) return;
    if (Math.hypot(a.x - u.x, a.y - u.y) > u.s.attackRange + u.radius + a.radius) return;
    it.cd = it.def.cd || iv(it, '_cd');
    const c = makeAttack(u, a, true);
    c.damage *= iv(it, 'counter_damage') / 100;
    landAttack(c);
  },
}));

// Mana Draught: maná en el tiempo; se pierde si te ataca un héroe enemigo. Sin agua en el mapa.
defineItem({
  key: 'mana_draught', target: 'unit', team: 'ally', allowSelf: true, castRange: (it) => iv(it, 'abilitycastrange'), ai: { role: 'mana' },
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    const total = iv(it, 'mana_restore') + u.s.maxMana * iv(it, 'mana_restore_pct') / 100;
    const dur = iv(it, 'heal_duration');
    e.addMod({
      name: 'bottoms_up', duration: dur, fx: 'mana', interval: 0.25,
      onInterval(m) { giveMana(m.owner as Unit, total / dur * 0.25); },
      onAttacked(m, ev) {
        const a = ev.attacker as Unit;
        if (a.team !== (m.owner as Unit).team && a.isHeroLike) m.remaining = 0.001;
      },
    }, u, it);
  },
});

// Crippling Crossbow: daño y ralentizado que se desvanece, menos curación.
defineItem({
  key: 'crippling_crossbow', target: 'unit', castRange: (it) => iv(it, 'abilitycastrange'), reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'crippling_crossbow', source: u, target: e, x: u.x, y: u.y, speed: iv(it, 'projectile_speed'), dodgeable: true,
      onHit() {
        if (!canDebuff(u, e, it)) return true;
        damage(u, e, iv(it, 'damage'), 'magical', it);
        const s = iv(it, 'slow_pct') / 100, hr = -iv(it, 'heal_reduce') / 100;
        debuff(u, e, it, {
          name: 'hobble', duration: iv(it, 'duration'), fx: 'slow',
          props: (m) => ({ msSlow: s * Math.max(0, m.remaining / m.duration), hpRegenAmp: hr }),
          interval: 0.2, onInterval(m) { (m.owner as Unit).refreshStats(); },
        });
        return true;
      },
    });
  },
});

// Searing Signet: los hechizos con más de 60 de daño mágico queman al objetivo.
passiveItem('searing_signet', (it) => ({
  onDealDamage(m, ev) {
    const u = m.owner as Unit, t = ev.target as Unit;
    if (ev.type !== 'magical' || ev.isAttack || !ev.ability || ev.ability === it || ev.hpRemoval) return;
    if (ev.amount < iv(it, 'damage_threshold') || t.team === u.team || !t.alive) return;
    if (Math.hypot(t.x - u.x, t.y - u.y) > iv(it, 'max_range')) return;
    const dur = iv(it, 'burn_duration');
    let dps = iv(it, 'burn_damage') / dur;
    if (!t.isHeroLike) dps *= 1 - iv(it, 'creep_penalty') / 100;
    dot(u, t, it, 'burn_through', dur, dps, 'magical', iv(it, 'burn_tickrate'), { fx: 'burn' });
  },
}));

// ======================= Tier 3 =======================

passiveItem('cloak_of_flames', (it) => ({
  interval: 1, fx: 'radiance',
  onInterval(m) {
    const u = m.owner as Unit;
    const d = u.kind === 'illusion' ? iv(it, 'damage_illusions') : iv(it, 'damage');
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'radius'))) damage(u, e, d, 'magical', it, { noProc: true });
  },
}));

defineItem({
  key: 'psychic_headband', target: 'unit', castRange: (it) => iv(it, 'abilitycastrange'), reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    if (!canDebuff(u, e, it)) return;
    e.w.interruptCast(e, true);
    push(e, e.x - u.x, e.y - u.y, iv(it, 'push_length'), iv(it, 'push_duration'), u, it, 'psychic_push');
  },
});

// Stormcrafter: cada 6 s, rayo a 2 enemigos cercanos (héroes primero).
passiveItem('stormcrafter', (it) => ({
  interval: 0.1,
  onInterval(m) {
    const u = m.owner as Unit;
    if (!real(u) || !u.alive || it.cd > 0 || u.has(ST.invisible)) return;
    const list = u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'range')).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e));
    if (!list.length) return;
    list.sort((a, b) => (+b.isHeroLike - +a.isHeroLike) || u.w.rng() - 0.5);
    it.cd = it.def.cd || iv(it, '_cd');
    for (const e of list.slice(0, iv(it, 'max_targets'))) {
      u.w.emit({ n: 'lightning', x: u.x, y: u.y, x2: e.x, y2: e.y });
      damage(u, e, iv(it, 'damage'), 'magical', it);
      slow(u, e, it, 'bottled_lightning', iv(it, 'slow_duration'), iv(it, 'slow') / 100);
    }
  },
}));

// Unrelenting Eye: resistencia a ralentizados que baja por cada héroe enemigo al alcance de ataque.
passiveItem('unrelenting_eye', (it) => ({
  data: { n: 0 },
  props: (m) => ({ slowResist: Math.max(0, iv(it, 'max_slow_res') - iv(it, 'hero_reduction') * m.data.n) / 100 }),
  interval: 0.25,
  onInterval(m) {
    const u = m.owner as Unit;
    const n = u.w.enemiesIn(u.team, u.x, u.y, u.s.attackRange + u.radius, { heroes: true }).filter((e) => e.kind === 'hero').length;
    if (n !== m.data.n) { m.data.n = n; u.refreshStats(); }
  },
}));

// Gunpowder Gauntlets: el siguiente ataque hace daño mágico y salpica (el dataset suma el daño: se compensa).
passiveItem('gunpowder_gauntlets', (it) => ({
  props: { damage: -iv(it, 'bonus_damage') },
  onAttackLanded(m, ev) {
    const u = m.owner as Unit, t = ev.target as Unit;
    if (!real(u) || it.cd > 0 || ev.fake) return;
    it.cd = it.def.cd || iv(it, '_cd');
    const extra = iv(it, 'bonus_damage');
    damage(u, t, extra, 'magical', it, { noProc: true });
    const pct = iv(it, 'splash_pct') / 100;
    u.w.emit({ n: 'aoe', x: t.x, y: t.y, r: iv(it, 'splash_radius'), t: u.team });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, iv(it, 'splash_radius'))) {
      if (e === t) continue;
      damage(u, e, ev.damage * ev.critMult * pct, 'physical', it, { noProc: true });
      damage(u, e, extra * pct, 'magical', it, { noProc: true });
    }
  },
}));

// Serrated Shiv: 20% de True Strike con 8% de la vida actual del objetivo como daño extra.
passiveItem('serrated_shiv', (it) => ({
  onAttackStart(m, ev) {
    const u = m.owner as Unit;
    if (!real(u) || it.cd > 0 || u.w.rng() >= iv(it, 'proc_chance') / 100) return;
    it.cd = it.def.cd || iv(it, '_cd');
    ev.trueStrike = true;
    (ev as any).gut = true;
  },
  onAttackLanded(_m, ev) {
    if (!(ev as any).gut) return;
    (ev as any).gut = false;
    const t = ev.target as Unit;
    ev.damage += t.hp * iv(it, 'hp_dmg') / 100 / ev.critMult;
  },
}));

// Jidi Pollen Bag: debuff de área con menos curación y daño por % de vida máxima
// (hp_damage es el total repartido en la duración).
defineItem({
  key: 'jidi_pollen_bag', target: 'none', ai: { role: 'aoe', selfRadius: 700 },
  onSpellStart(it) {
    const u = own(it);
    const r = iv(it, 'debuff_radius'), dur = iv(it, 'debuff_duration');
    u.w.emit({ n: 'aoe', x: u.x, y: u.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      debuff(u, e, it, {
        name: 'pollinate', duration: dur, fx: 'poison', interval: iv(it, 'damage_interval'),
        props: { hpRegenAmp: -iv(it, 'health_regen_loss') / 100 },
        onInterval(m) {
          const t = m.owner as Unit;
          damage(u, t, t.s.maxHp * iv(it, 'hp_damage') / 100 / dur * iv(it, 'damage_interval'), 'magical', it, { noProc: true });
        },
      });
    }
  },
});

// Spellslinger: recupera el 20% del maná gastado en habilidades en 10 s.
passiveItem('spellslinger', (it) => ({
  onAbilityExecuted(m, a) {
    const u = m.owner as Unit;
    if (isItemSrc(a)) return;
    const amt = manaCostOf(a as AbilityInst) * iv(it, 'mana_pct') / 100;
    if (amt <= 0) return;
    const tick = iv(it, 'restore_tickrate'), dur = iv(it, 'duration');
    u.addMod({
      name: 'salvo', duration: dur + 0.01, interval: tick, data: { multi: true },
      onInterval(mm) { giveMana(mm.owner as Unit, amt * tick / dur); },
    }, u, it);
  },
}));

// Partisan's Brand: +9% de daño de hechizos contra unidades de jugadores.
passiveItem('partisans_brand', (it) => ({
  onDealDamage(m, ev) {
    const u = m.owner as Unit, t = ev.target as Unit;
    if (ev.isAttack || !ev.ability || ev.hpRemoval || ev.data?.brand || t.team === u.team || !t.playerId || !t.alive) return;
    damage(u, t, ev.amount * iv(it, 'bonus_damage_pct') / 100, ev.type, null, { hpRemoval: true, noProc: true, data: { brand: true } });
  },
}));

// ======================= Tier 4 =======================

// Dandelion Amulet: cada 12 s bloquea hasta 300 de una instancia mágica de más de 75.
passiveItem('dandelion_amulet', (it) => ({
  onIncomingDamage(m, ev) {
    if (it.cd > 0 || ev.type !== 'magical' || ev.hpRemoval || ev.amount <= iv(it, 'min_damage')) return;
    const u = m.owner as Unit, s = ev.source as Unit | null;
    if (!s || s.team === u.team) return;
    ev.amount = Math.max(0, ev.amount - iv(it, 'magic_block'));
    it.cd = it.def.cd || iv(it, '_cd');
    u.w.emit({ n: 'barrier', x: u.x, y: u.y, u: u.id });
  },
}));

// Rattlecage: tras recibir 220 de daño dispara a 2 enemigos cercanos.
passiveItem('rattlecage', (it) => ({
  data: { acc: 0, last: -99 },
  onTakeDamage(m, ev) {
    const u = m.owner as Unit;
    if (!real(u) || ev.data?.rattle) return;
    if (u.w.time - m.data.last > iv(it, 'damage_reset_interval')) m.data.acc = 0;
    m.data.last = u.w.time;
    m.data.acc += ev.amount;
    if (m.data.acc < iv(it, 'damage_threshold')) return;
    m.data.acc = 0;
    const list = u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'radius')).filter((e) => e.kind !== 'ward');
    list.sort((a, b) => (+b.isHeroLike - +a.isHeroLike) || u.w.rng() - 0.5);
    for (const e of list.slice(0, iv(it, 'target_count'))) {
      u.w.addProjectile({
        kind: 'track', fx: 'rattlecage', source: u, target: e, x: u.x, y: u.y, speed: iv(it, 'projectile_speed'),
        onHit() {
          damage(u, e, iv(it, 'projectile_damage'), 'physical', it, { noProc: true, data: { rattle: true } });
          slow(u, e, it, 'reverberate', iv(it, 'slow_duration'), iv(it, 'slow') / 100, e.s.as * iv(it, 'slow') / 100);
          return true;
        },
      });
    }
  },
}));

// Giant Maul: cada 15 s el siguiente ataque es crítico y ralentiza (la velocidad de lanzamiento no se modela).
passiveItem('giant_maul', (it) => ({
  onAttackStart(m, ev) {
    if (!real(m.owner as Unit) || it.cd > 0 || ev.fake) return;
    ev.critMult = Math.max(ev.critMult, iv(it, 'crit_multiplier') / 100);
    (ev as any).maul = true;
  },
  onAttackLanded(m, ev) {
    if (!(ev as any).maul) return;
    (ev as any).maul = false;
    const u = m.owner as Unit, t = ev.target as Unit;
    it.cd = it.def.cd || iv(it, '_cd');
    slow(u, t, it, 'crushing_blow', iv(it, 'debuff_duration'), iv(it, 'movespeed_slow') / 100, t.s.as * iv(it, 'attack_slow') / 100);
  },
}));

// Metamorphic Mandible: forma de insecto (el dataset suma la resistencia mágica siempre: se compensa).
defineItem({
  key: 'metamorphic_mandible', target: 'none', ai: { role: 'escape' },
  passive: (it) => ({ name: 'p_metamorphic_mandible', props: { magicResist: undoMult(iv(it, 'bonus_magic_resistance') / 100) } }),
  onSpellStart(it) {
    const u = own(it);
    const armor = Math.max(0, u.s.armor) * iv(it, 'armor_decrease') / 100;
    u.addMod({ name: 'pupate', duration: iv(it, 'duration'), fx: 'pupate', props: {
      magicResist: iv(it, 'bonus_magic_resistance') / 100, msPct: iv(it, 'bonus_movespeed') / 100, armor: -armor,
    } }, u, it);
  },
});

// Idol of Screeauk: falso vuelo (el dataset suma la evasión siempre: se compensa).
defineItem({
  key: 'idol_of_screeauk', target: 'none', ai: { role: 'escape' },
  passive: (it) => ({ name: 'p_idol_of_screeauk', props: { evasion: undoMult(iv(it, 'evasion') / 100) } }),
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'false_flight', duration: iv(it, 'duration'), fx: 'haste', states: ST.noCollision, props: {
      slowResist: iv(it, 'slow_resist') / 100, evasion: iv(it, 'evasion') / 100,
    } }, u, it);
  },
});

// Flayer's Bota: +15% de daño base y velocidad de ataque; una muerte de héroe enemigo cerca reinicia el enfriamiento.
defineItem({
  key: 'flayers_bota', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  passive: (it) => ({
    name: 'p_flayers_bota',
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      if (Math.hypot(victim.x - u.x, victim.y - u.y) <= iv(it, 'death_radius')) it.cd = 0;
    },
  }),
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'bloodthirst', duration: iv(it, 'duration'), fx: 'berserk', props: {
      damagePct: iv(it, 'base_damage') / 100, attackSpeed: iv(it, 'attack_speed'),
    } }, u, it);
  },
});

// Prophet's Pendulum: el 30% del daño recibido llega repartido en 5 s.
passiveItem('prophets_pendulum', (it) => ({
  onIncomingDamage(m, ev) {
    if (ev.hpRemoval || ev.data?.linger || ev.amount <= 0) return;
    const u = m.owner as Unit;
    const delayed = ev.amount * iv(it, 'delay_pct') / 100;
    ev.amount -= delayed;
    const step = iv(it, 'damage_interval'), dur = iv(it, 'delay_time');
    const src = ev.source as Unit | null, type = ev.type;
    u.addMod({
      name: 'linger', duration: dur + 0.01, interval: step, data: { multi: true }, persistent: false,
      onInterval(mm) { damage(src, mm.owner as Unit, delayed * step / dur, type, null, { hpRemoval: true, noProc: true, data: { linger: true } }); },
    }, u, it);
  },
}));

enhancementBoost('enchanters_bauble', (it) => iv(it, 'enchantment_bonus_base') + iv(it, 'current_bonus'));

// Conjurer's Catalyst: al acumular 200 de daño de hechizo sobre un enemigo, este daña a sus aliados cercanos.
passiveItem('conjurers_catalyst', (it) => ({
  data: { acc: new Map<number, { amt: number; at: number }>() },
  onDealDamage(m, ev) {
    const u = m.owner as Unit, t = ev.target as Unit;
    if (ev.isAttack || !ev.ability || ev.ability === it || t.team === u.team) return;
    const acc: Map<number, { amt: number; at: number }> = m.data.acc;
    let e = acc.get(t.id);
    if (!e || u.w.time - e.at > iv(it, 'duration')) { e = { amt: 0, at: u.w.time }; acc.set(t.id, e); }
    e.amt += ev.amount;
    if (e.amt < iv(it, 'damage_threshold')) return;
    acc.delete(t.id);
    const d = t.isHeroLike ? iv(it, 'damage') : iv(it, 'damage_creep');
    u.w.emit({ n: 'aoe', x: t.x, y: t.y, r: iv(it, 'damage_aoe'), t: u.team });
    for (const o of u.w.alliesIn(t.team, t.x, t.y, iv(it, 'damage_aoe'))) {
      if (o !== t) damage(u, o, d, 'magical', it, { noProc: true });
    }
  },
}));

// ======================= Tier 5 =======================

passiveItem('desolator_2', (it) => ({
  onAttackLanded(m, ev) {
    debuff(m.owner as Unit, ev.target as Unit, it, { name: 'greater_corruption', duration: iv(it, 'corruption_duration'), fx: 'corruption',
      props: { armor: iv(it, 'corruption_armor') }, purgable: false });
  },
}));

// Spider Legs: velocidad, sin colisión y tala los árboles que pisa (el giro no se modela).
defineItem({
  key: 'spider_legs', target: 'none', ai: { role: 'escape' },
  onSpellStart(it) {
    const u = own(it);
    u.addMod({
      name: 'skitter', duration: iv(it, 'duration'), fx: 'haste', states: ST.noCollision,
      props: { msPct: iv(it, 'bonus_movement_speed_active') / 100 },
      interval: 0.1, onInterval(m) { const o = m.owner as Unit; o.w.cutTrees(o.x, o.y, o.radius + 40); },
    }, u, it);
  },
});

// Demonicon: 2 guerreros y 2 arqueros demoníacos (stats aproximados del Necronomicon 3).
const WARRIOR = {
  hp: 1100, hpRegen: 2, mana: 0, manaRegen: 0, armor: 6, mr: 0, dmgMin: 75, dmgMax: 75, bat: 1.2, attackPoint: 0.5,
  range: 100, projSpeed: 900, ms: 330, dayVision: 1400, nightVision: 800, turnRate: 0.6, melee: true,
};
const ARCHER = {
  hp: 900, hpRegen: 2, mana: 400, manaRegen: 1, armor: 4, mr: 0, dmgMin: 70, dmgMax: 70, bat: 1, attackPoint: 0.7,
  range: 600, projSpeed: 1200, ms: 330, dayVision: 1400, nightVision: 800, turnRate: 0.6, melee: false,
};
defineItem({
  key: 'demonicon', target: 'none', ai: { role: 'summon' },
  onSpellStart(it) {
    const u = own(it);
    const dur = iv(it, 'summon_duration');
    for (let i = 0; i < 4; i++) {
      const warrior = i < 2;
      const ang = u.facing + (i - 1.5) * 0.6;
      const s = u.w.spawnSummon(u, warrior ? { ...WARRIOR } : { ...ARCHER }, u.x + Math.cos(ang) * 150, u.y + Math.sin(ang) * 150, dur,
        { name: warrior ? 'demonic_warrior' : 'demonic_archer', bounty: 100, xp: 100 });
      if (warrior) {
        s.addMod({
          name: 'demonic_warrior', persistent: true, props: { trueSight: 1000 },
          onAttackLanded(_m, ev) {
            const t = ev.target as Unit;
            const b = Math.min(t.mana, 70);
            if (b > 0) { t.mana -= b; damage(s, t, b, 'physical', it, { noProc: true }); }
          },
          onDeath(_m, killer) { if (killer && killer.team !== s.team && killer.alive) damage(s, killer as Unit, 700, 'magical', it, { noProc: true }); },
        }, u, it);
      } else {
        s.addMod({
          name: 'demonic_archer', persistent: true, interval: 0.5,
          aura: { radius: 1200, team: 'ally', apply: () => ({ name: 'demonic_archer_aura', props: { msPct: 0.05 } }) },
          onInterval(m) {
            // Purga automática con ralentizado sobre el héroe enemigo más cercano.
            if (m.data.ready > s.w.time) return;
            const e = s.w.enemiesIn(s.team, s.x, s.y, 600, { heroes: true })[0];
            if (!e) return;
            m.data.ready = s.w.time + 10;
            e.purge(false, true);
            slow(s, e, it, 'archer_purge', 4, 0.5);
          },
        }, u, it);
      }
      u.w.issueOrder(s, { type: 'attackMove', x: u.x + Math.cos(u.facing) * 600, y: u.y + Math.sin(u.facing) * 600 });
    }
  },
});

// Fallen Sky: el héroe cae como meteoro en el punto: aturde, daña y quema.
defineItem({
  key: 'fallen_sky', target: 'point', castRange: (it) => iv(it, 'abilitycastrange'), ai: { role: 'aoe', selfRadius: 1000 },
  check: (it) => (own(it).w.time - own(it).lastHeroDamageAt < iv(it, 'blink_damage_cooldown') ? 'Desactivado por daño' : null),
  onSpellStart(it, t) {
    const u = own(it);
    if (u.has(ST.rooted)) { it.cd = 0; return; }
    const land = iv(it, 'land_time'), r = iv(it, 'impact_radius');
    u.order = null; u.path = [];
    u.w.disjoint(u);
    u.w.emit({ n: 'fallen_sky', x: t.x, y: t.y, r, d: land, t: u.team });
    u.addMod({ name: 'fallen_sky', duration: land, states: ST.busy | ST.invulnerable | ST.untargetable | ST.noCollision | ST.flying }, u, it);
    u.w.after(land, () => {
      if (!u.alive) return;
      u.w.teleport(u, t.x, t.y);
      u.w.cutTrees(t.x, t.y, r);
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        damage(u, e, iv(it, 'impact_damage_units'), 'magical', it);
        stun(u, e, iv(it, 'stun_duration'), it);
        dot(u, e, it, 'fallen_sky_burn', iv(it, 'burn_duration'), iv(it, 'burn_dps_units'), 'magical', iv(it, 'burn_interval'), { fx: 'burn' });
      }
    });
  },
});

// Minotaur Horn: disipación básica, resistencia mágica e inmunidad a debuffs, daño puro y reflejado.
defineItem({
  key: 'minotaur_horn', target: 'none', ai: { role: 'bkb', selfRadius: 700 },
  onSpellStart(it) {
    const u = own(it);
    u.purge(true, false);
    u.addMod({
      name: 'lesser_avatar', duration: iv(it, 'duration'), fx: 'bkb', states: ST.magicImmune,
      props: { magicResist: iv(it, 'magic_resist') / 100 },
      onIncomingDamage(_m, ev) { if (ev.type === 'pure' || ev.data?.reflected) ev.amount = 0; },
    }, u, it);
  },
});

// Heavy Blade: activa de disipación en área y ataques con daño mágico por % de maná máximo.
defineItem({
  key: 'heavy_blade', target: 'point', castRange: (it) => iv(it, 'abilitycastrange'), ai: { role: 'aoe', selfRadius: 600 },
  passive: (it) => ({
    name: 'p_heavy_blade',
    onAttackLanded(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (t.s.maxMana > 0) damage(u, t, t.s.maxMana * iv(it, 'damage') / 100, 'magical', it, { noProc: true });
    },
  }),
  onSpellStart(it, t) {
    const u = own(it), r = iv(it, 'radius');
    u.w.emit({ n: 'aoe', x: t.x, y: t.y, r, t: u.team });
    for (const a of u.w.unitsIn(t.x, t.y, r, (o) => u.w.targetable(o) && o.kind !== 'fountain')) {
      if (a.team === u.team) a.purge(true, false);
      else if (canDebuff(u, a, it)) a.purge(false, true);
    }
  },
});

// Dezun Bloodrite: los hechizos cuestan además vida (el +20% de área no se modela).
passiveItem('dezun_bloodrite', (it) => ({
  onAbilityExecuted(m, a) {
    if (isItemSrc(a)) return;
    const u = m.owner as Unit;
    const cost = manaCostOf(a as AbilityInst) * iv(it, 'health_pct') / 100;
    if (cost > 0) u.hp = Math.max(1, u.hp - cost);
  },
}));

// Divine Regalia: +20% de daño infligido; al morir se desactiva para siempre y se pierde el encantamiento.
passiveItem('divine_regalia', (it) => ({
  props: () => (it.data.broken ? {} : { outgoingPct: iv(it, 'outgoing_damage') / 100 }),
  onDeath(m) {
    const u = m.owner as Unit;
    if (u.kind !== 'hero' || it.data.broken) return;
    it.data.broken = true;
    u.removeModsByName('enhancement');
    u.refreshStats();
  },
}));

// Riftshadow Prism: gasta vida para crear una ilusión con vida completa.
defineItem({
  key: 'riftshadow_prism', target: 'none', ai: { role: 'summon' },
  onSpellStart(it) {
    const u = own(it);
    u.hp = Math.max(1, u.hp * (1 - iv(it, 'health_cost') / 100));
    const ang = u.facing + Math.PI / 2;
    const il = u.w.spawnIllusion(u, u.x + Math.cos(ang) * 100, u.y + Math.sin(ang) * 100, iv(it, 'duration'),
      iv(it, 'outgoing_damage') / 100 - 1, iv(it, 'incoming_damage') / 100 - 1);
    il.hp = il.s.maxHp;
    if (u.order) u.w.issueOrder(il, { ...u.order } as any);
  },
});

// Harmonizer: menos coste de maná por hechizo listo y amplificación por hechizo en enfriamiento
// (el dataset suma el spell_amp siempre: se compensa).
passiveItem('harmonizer', (it) => ({
  data: { ready: 0, cd: 0 },
  props: (m) => ({
    manaReduce: iv(it, 'manacost_reduction') * m.data.ready / 100,
    spellAmp: iv(it, 'spell_amp') * (m.data.cd - 1) / 100,
  }),
  interval: 0.25,
  onInterval(m) {
    const u = m.owner as Unit;
    let ready = 0, cd = 0;
    for (const a of u.abilities) {
      if (a.level <= 0 || a.impl.target === 'passive' || a.impl.sub || a.impl.innate) continue;
      const hidden = typeof a.impl.hidden === 'function' ? a.impl.hidden(a) : a.impl.hidden;
      if (hidden) continue;
      if (a.cd > 0 || (a.impl.charges && a.charges <= 0)) cd++; else ready++;
    }
    if (ready !== m.data.ready || cd !== m.data.cd) { m.data.ready = ready; m.data.cd = cd; u.refreshStats(); }
  },
}));
