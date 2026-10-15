// Mecánicas de items. Los stats planos (fuerza, daño, armadura…) ya los aplica
// sim/items.ts desde el dataset (solo las claves de STAT_KEYS); aquí va lo que hace
// cada item además de eso, y los stats con claves que STAT_KEYS no conoce.
import { ITEMS, lv } from '../data';
import { isItem } from '../sim/abilities';
import { burnMana, creditHero, damage, dealDamage, giveMana, heal, kill, launchAttack } from '../sim/combat';
import { atShop, defineItem, itemLevel, makeItem } from '../sim/items';
import type { CastTarget, ItemImpl, ItemInst, ModSpec, Modifier, Props } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { canDebuff, debuff, hex, nearestEnemy, push, reflectSpell, root, silence, slow, stun } from '../heroes/util';

/** Valor del item (respeta el nivel de Dagon y similares). */
const iv = (it: ItemInst, k: string) => lv(it.def.values[k], itemLevel(it.key));
const own = (it: ItemInst) => it.owner as Unit;
/** Alcance de lanzamiento del dataset. */
const cr = (it: ItemInst) => iv(it, 'abilitycastrange');
/** Las ilusiones no disparan procs de items (bash, rayos, críticos de item). */
const real = (u: Unit) => u.kind === 'hero';
/** Daño de hechizo (no ataque ni pérdida de vida): lo que amplifican Veil o Bloodstone. */
const isSpellDamage = (ev: { isAttack: boolean; ability: unknown; hpRemoval?: boolean }) => !ev.isAttack && !!ev.ability && !ev.hpRemoval;
/** Unidad controlada por un jugador (héroe, ilusión, invocación): Aeon Disk, Consecrated Wraps. */
const playerOwned = (s: Unit | null) => !!s && (!!creditHero(s) || !!s.playerId);
/** Recalcula stats periódicamente para props que dependen del tiempo. */
const refreshEvery = (t = 0.2) => ({ interval: t, onInterval(m: Modifier) { (m.owner as Unit).refreshStats(); } });
/** Dirección normalizada de a hacia b (o hacia donde mira a). */
function dirTo(a: Unit, b: { x: number; y: number }): [number, number] {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  return d < 1 ? [Math.cos(a.facing), Math.sin(a.facing)] : [dx / d, dy / d];
}

/** Item sin activa cuyo extra no cambia nada en esta versión: solo stats. */
function statsItem(key: string, props?: Partial<Props> | ((it: ItemInst) => ModSpec['props'])) {
  defineItem({
    key, target: 'passive',
    passive: props ? (it) => ({ name: 'p_' + key, props: typeof props === 'function' ? props(it) : props }) : undefined,
  });
}

function passiveItem(key: string, passive: (it: ItemInst) => Omit<ModSpec, 'name'>, extra: Partial<ItemImpl> = {}) {
  defineItem({ key, target: 'passive', passive: (it) => ({ name: 'p_' + key, ...passive(it) }), ...extra });
}

/** Aura de item: `props` se aplica a aliados (o enemigos) en el radio. */
function auraSpec(_it: ItemInst, name: string, radius: number, team: 'ally' | 'enemy', props: ModSpec['props'], extra: Partial<ModSpec> = {}): ModSpec['aura'] {
  return {
    radius, team,
    apply: () => ({ name, debuff: team === 'enemy', props, ...extra }),
  };
}

/** Quita el item del inventario (consumido). */
function consume(it: ItemInst) {
  const u = own(it);
  const i = u.items.indexOf(it);
  if (i >= 0) u.items[i] = null;
  if (it.passiveMod) { u.removeMod(it.passiveMod); it.passiveMod = null; }
}
function useCharge(it: ItemInst) {
  it.charges--;
  if (it.charges <= 0) consume(it);
}
/** Cancela un lanzamiento que no procede: sin enfriamiento ni coste. */
function refund(it: ItemInst, msg: string) {
  const u = own(it);
  it.cd = 0;
  u.mana = Math.min(u.s.maxMana, u.mana + it.def.mc);
  u.w.error(u, msg);
}
/** Recarga de cargas con el tiempo (Midas, Holy Locket). */
function chargeRegen(it: ItemInst, max: number, every: number) {
  const w = own(it).w;
  if (it.charges >= max) { it.data.nextCharge = 0; return; }
  if (!it.data.nextCharge) it.data.nextCharge = w.time + every;
  if (w.time >= it.data.nextCharge) { it.charges++; it.data.nextCharge = it.charges < max ? w.time + every : 0; }
}
const needCharges = (it: ItemInst) => (it.charges > 0 ? null : 'Sin cargas');

/** Aturdido que atraviesa la inmunidad a hechizos (Abyssal Blade). */
function stunPierce(src: Unit, t: Unit, duration: number, it: ItemInst) {
  if (!t.alive) return null;
  const m = t.addMod({ name: 'stunned', duration, debuff: true, states: ST.stunned, fx: 'stun' }, src, it);
  t.atk.phase = 0;
  if (t.cast) t.w.interruptCast(t, true);
  return m;
}

/** Ralentizado que decae del máximo a 0 durante la duración (Diffusal, Disperser). */
function decayingSlow(src: Unit, t: Unit, it: ItemInst, name: string, duration: number, max: number) {
  return debuff(src, t, it, {
    name, duration, fx: 'slow',
    props: (m) => ({ msSlow: max * Math.max(0, m.remaining / (m.duration || 1)) }),
    ...refreshEvery(),
  });
}

/** Escudo que absorbe daño de un tipo ('all' = cualquiera). */
function barrier(amount: number, type: 'magical' | 'physical' | 'all'): Partial<ModSpec> {
  return {
    data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (type !== 'all' && ev.type !== type)) return;
      const a = Math.min(m.data.left, ev.amount);
      m.data.left -= a; ev.amount -= a;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}
const magicBarrier = (amount: number) => barrier(amount, 'magical');

/** Porcentaje de un stat ya calculado, sin contar lo que aporta el propio modificador. */
function pctOfStat(m: Modifier, stat: 'maxMana' | 'as', pct: number, slot: string) {
  const u = m.owner as Unit;
  const base = (u.s?.[stat] ?? 0) - (m.data[slot] ?? 0);
  const v = base * pct;
  m.data[slot] = v;
  return v;
}

// ---------------- Consumibles ----------------

function regenConsumable(key: string, kind: 'hp' | 'mana', breakOnDamage: boolean) {
  defineItem({
    key, target: 'unit', team: 'ally', allowSelf: true, consumable: true, castRange: cr,
    ai: { role: kind === 'hp' ? 'heal' : 'mana' },
    onSpellStart(it, t) {
      const u = own(it);
      const target = (t.unit as Unit) ?? u;
      let per = kind === 'hp' ? iv(it, 'health_regen') : iv(it, 'mana_regen');
      // Salve sobre un aliado: la mitad por segundo.
      if (key === 'flask' && target !== u) per /= 2;
      target.addMod({
        name: key + '_regen', duration: iv(it, 'buff_duration'), fx: key,
        props: kind === 'hp' ? { hpRegen: per } : { manaRegen: per },
        onTakeDamage(m, ev) {
          const s = ev.source as Unit | null;
          if (breakOnDamage && s && s.team !== (m.owner as Unit).team && (s.isHeroLike)) (m.owner as Unit).removeMod(m);
        },
      }, u, it);
      useCharge(it);
    },
  });
}
regenConsumable('flask', 'hp', true);
regenConsumable('clarity', 'mana', true);

// Tango: se come un árbol cercano; sobre un aliado le pasa un Tango.
defineItem({
  key: 'tango', target: 'unit', team: 'ally', allowSelf: true, consumable: true, castRange: cr, ai: { role: 'heal' },
  onSpellStart(it, t) {
    const u = own(it);
    const target = (t.unit as Unit) ?? u;
    if (target !== u) {
      if (!target.isHero) { refund(it, 'Solo a héroes aliados'); return; }
      const stack = target.items.find((i) => i?.key === 'tango');
      if (stack) stack.charges++;
      else {
        const s = target.freeSlot();
        if (s < 0) { refund(it, 'Inventario lleno'); return; }
        const gift = makeItem(target, 'tango');
        gift.charges = 1;
        target.items[s] = gift;
      }
      useCharge(it);
      return;
    }
    // Aproximación: el árbol se busca alrededor del héroe en vez de apuntarlo.
    const tree = u.w.nearestTree(u.x, u.y, iv(it, 'abilitycastrange') + 150);
    if (!tree) { refund(it, 'No hay ningún árbol cerca'); return; }
    u.w.cutTrees(tree.x, tree.y, 1);
    u.addMod({ name: 'tango_regen', duration: iv(it, 'buff_duration'), fx: 'tango', props: { hpRegen: iv(it, 'health_regen') } }, u, it);
    useCharge(it);
  },
});

defineItem({
  key: 'enchanted_mango', target: 'none', consumable: true, ai: { role: 'mana' },
  // Consumible: sim/items.ts no le aplica stats, la regeneración pasiva va aquí.
  passive: (it) => ({ name: 'p_mango', props: { hpRegen: iv(it, 'hp_regen') } }),
  onSpellStart(it) { giveMana(own(it), iv(it, 'replenish_amount')); useCharge(it); },
});
defineItem({
  key: 'faerie_fire', target: 'none', consumable: true, ai: { role: 'heal' },
  passive: (it) => ({ name: 'p_faerie_fire', props: { damage: iv(it, 'bonus_damage') } }),
  onSpellStart(it) { heal(own(it), iv(it, 'hp_restore')); useCharge(it); },
});

defineItem({
  key: 'tpscroll', target: 'none', consumable: true, channel: (it) => iv(it, 'abilitychanneltime'), ai: { role: 'tp' },
  onSpellStart(it) {
    const u = own(it);
    const f = u.w.teams[u.team]?.fountain;
    if (f) u.w.emit({ n: 'tp', x: f.x, y: f.y, u: u.id, d: iv(it, 'abilitychanneltime'), t: u.team });
  },
  onChannelEnd(it, interrupted) {
    const u = own(it);
    if (interrupted) { it.cd = 0; return; }
    const f = u.w.teams[u.team]?.fountain;
    if (f) u.w.teleport(u, f.x, f.y);
    // Boots of Travel: menos enfriamiento y no gasta la carga.
    const travel = u.items.find((i, s) => s < 6 && i?.key === 'travel_boots');
    if (travel) { it.cd = iv(travel, 'tp_cooldown'); return; }
    useCharge(it);
  },
});

function stickItem(key: string) {
  defineItem({
    key, target: 'none', ai: { role: 'heal' },
    passive: (it) => ({
      name: 'p_' + key,
      data: { onEnemyCast: () => { it.charges = Math.min(iv(it, 'max_charges'), it.charges + 1); } },
    }),
    onSpellStart(it) {
      const u = own(it);
      const amt = it.charges * iv(it, 'restore_per_charge');
      heal(u, amt); giveMana(u, amt);
      it.charges = 0;
    },
  });
}
stickItem('magic_stick');
stickItem('magic_wand');

defineItem({
  key: 'dust', target: 'none', consumable: true,
  onSpellStart(it) {
    const u = own(it);
    u.w.emit({ n: 'dust', x: u.x, y: u.y, r: iv(it, 'radius'), t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'radius'))) {
      e.addMod({ name: 'reveal', duration: iv(it, 'duration'), debuff: true, states: ST.revealed, fx: 'dust',
        props: { msSlow: Math.abs(iv(it, 'movespeed')) / 100 }, data: { team: u.team } }, u, it);
    }
    useCharge(it);
  },
});

// Infused Raindrops: cada carga bloquea daño mágico grande.
passiveItem('infused_raindrop', (it) => ({
  onIncomingDamage(m, ev) {
    if (ev.type !== 'magical' || ev.hpRemoval || it.cd > 0 || it.charges <= 0 || ev.amount < iv(it, 'min_damage')) return;
    ev.amount = Math.max(0, ev.amount - iv(it, 'magic_damage_block'));
    it.cd = it.def.cd;
    useCharge(it);
    (m.owner as Unit).w.emit({ n: 'raindrop', x: (m.owner as Unit).x, y: (m.owner as Unit).y, u: (m.owner as Unit).id });
  },
}));

// ---------------- Solo stats (y claves que STAT_KEYS no conoce) ----------------

for (const k of ['branches', 'dragon_lance', 'travel_boots']) statsItem(k);
statsItem('wind_lace', (it) => ({ msFlat: iv(it, 'movement_speed') }));
statsItem('null_talisman', (it) => (m: Modifier) => ({ mana: pctOfStat(m, 'maxMana', iv(it, 'bonus_max_mana_percentage') / 100, 'mp') }));
statsItem('octarine_core', (it) => ({ cdr: iv(it, 'bonus_cooldown') / 100 }));
// Butterfly: % de velocidad de ataque sobre el total.
statsItem('butterfly', (it) => (m: Modifier) => ({ attackSpeed: pctOfStat(m, 'as', iv(it, 'bonus_attack_speed_pct') / 100, 'as') }));
// movement_speed_percent_bonus ya lo suma sim/items.ts; aquí solo la diferencia de cuerpo a cuerpo.
const meleeMsDiff = (it: ItemInst) => ({ msPct: own(it).melee ? (iv(it, 'movement_speed_percent_bonus_melee') - iv(it, 'movement_speed_percent_bonus')) / 100 : 0 });
statsItem('sange_and_yasha', meleeMsDiff);
statsItem('yasha_and_kaya', meleeMsDiff);
statsItem('kaya_and_sange', (it) => ({ manaReduce: iv(it, 'manacost_reduction') / 100 }));
// Tranquil Boots: atacar a un héroe o recibir un ataque corta la regeneración y baja la velocidad.
passiveItem('tranquil_boots', (it) => ({
  props: () => {
    const broken = (it.data.brokenUntil ?? 0) > own(it).w.time;
    return broken ? { hpRegen: -iv(it, 'bonus_health_regen'), msFlat: iv(it, 'broken_movement_speed') - iv(it, 'bonus_movement_speed') } : {};
  },
  ...refreshEvery(0.5),
  onAttackLanded(m, ev) {
    if (!(ev.target as Unit).isHeroLike) return;
    it.data.brokenUntil = (m.owner as Unit).w.time + iv(it, 'break_time'); (m.owner as Unit).refreshStats();
  },
  onAttacked(m) { it.data.brokenUntil = (m.owner as Unit).w.time + iv(it, 'break_time'); (m.owner as Unit).refreshStats(); },
}));
// Heart: +1.5% de la vida que falta por segundo (y +1 de regeneración plana, hp_regen).
passiveItem('heart', (it) => ({
  props: (m) => {
    const u = m.owner as Unit;
    return { hpRegen: (u.s ? (u.s.maxHp - u.hp) * iv(it, 'missing_health_regen') / 100 : 0) + iv(it, 'hp_regen') };
  },
  ...refreshEvery(0.5),
}));

// Bloqueo de daño con probabilidad.
function blockSpec(it: ItemInst): Partial<ModSpec> {
  return {
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (!ev.isAttack || ev.hpRemoval) return;
      if (u.w.rng() >= iv(it, 'block_chance') / 100) return;
      const b = u.melee ? iv(it, 'block_damage_melee') : iv(it, 'block_damage_ranged');
      ev.amount = Math.max(0, ev.amount - b);
    },
  };
}
passiveItem('vanguard', blockSpec);

/** Activa de talar: destruye el árbol apuntado. */
const chopTree: Partial<ItemImpl> = {
  target: 'point', castRange: cr,
  onSpellStart(it, t) {
    const u = own(it);
    const tree = u.w.nearestTree(t.x, t.y, 120);
    if (!tree) { refund(it, 'Ahí no hay ningún árbol'); return; }
    u.w.cutTrees(tree.x, tree.y, 1);
  },
};
passiveItem('quelling_blade', (it) => ({
  onAttackStart(_m, ev) {
    if (ev.target.kind === 'creep') ev.damage += (own(it).melee ? iv(it, 'damage_bonus') : iv(it, 'damage_bonus_ranged'));
  },
}), chopTree);

// ---------------- Auras ----------------

passiveItem('ring_of_basilius', (it) => ({ aura: auraSpec(it, 'basilius_aura', iv(it, 'aura_radius'), 'ally', { manaRegen: iv(it, 'aura_mana_regen') }) }));
passiveItem('buckler', (it) => ({ aura: auraSpec(it, 'buckler_aura', iv(it, 'bonus_aoe_radius'), 'ally', { armor: iv(it, 'bonus_aoe_armor') }) }));
passiveItem('headdress', (it) => ({ aura: auraSpec(it, 'headdress_aura', iv(it, 'aura_radius'), 'ally', { hpRegen: iv(it, 'aura_health_regen') }) }));
passiveItem('vladmir', (it) => ({
  aura: {
    radius: iv(it, 'aura_radius'), team: 'ally', includeSelf: true,
    apply: () => ({
      name: 'vladmir_aura',
      props: {
        armor: iv(it, 'armor_aura'), manaRegen: iv(it, 'mana_regen_aura'),
        lifesteal: iv(it, 'lifesteal_aura') / 100, damagePct: iv(it, 'damage_aura') / 100,
      },
    }),
  },
}));
// Assault: la aura negativa para enemigos va en un segundo modificador.
defineItem({
  key: 'assault', target: 'passive',
  passive: (it) => ({
    name: 'p_assault',
    aura: auraSpec(it, 'assault_aura', iv(it, 'aura_radius'), 'ally', { attackSpeed: iv(it, 'aura_attack_speed'), armor: iv(it, 'aura_positive_armor') }),
    onCreated(m) {
      const u = m.owner as Unit;
      m.data.neg = u.addMod({ name: 'assault_neg', persistent: true, data: { multi: true },
        aura: auraSpec(it, 'assault_neg_aura', iv(it, 'aura_radius'), 'enemy', { armor: iv(it, 'aura_negative_armor') }) }, u, it);
    },
    onDestroy(m) { (m.owner as Unit).removeMod(m.data.neg); },
  }),
});
// Radiance: se puede apagar (alternar). Empieza encendida.
defineItem({
  key: 'radiance', target: 'toggle',
  passive: (it) => ({
    name: 'p_radiance', interval: 1, fx: 'radiance',
    onCreated() { if (!it.data.init) { it.data.init = true; it.toggled = true; } },
    onInterval(m) {
      if (!it.toggled) return;
      const u = m.owner as Unit;
      const d = u.kind === 'illusion' ? iv(it, 'aura_damage_illusions') : iv(it, 'aura_damage');
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'aura_radius'))) damage(u, e, d, 'magical', it, { noProc: true });
    },
  }),
});
passiveItem('arcane_boots', (it) => ({ aura: auraSpec(it, 'arcane_aura_item', iv(it, 'aura_radius'), 'ally', { manaRegen: iv(it, 'aura_mana_regen') }) }), {
  target: 'none', ai: { role: 'mana' },
  onSpellStart(it) {
    const u = own(it);
    u.w.emit({ n: 'arcane_boots', x: u.x, y: u.y, r: iv(it, 'replenish_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'replenish_radius'), { heroes: true })) giveMana(a, iv(it, 'replenish_amount'));
  },
});

// ---------------- Ataque: críticos, bash, rayos, orbes ----------------

function critItem(key: string) {
  passiveItem(key, (it) => ({
    onAttackStart(m, ev) {
      if (!real(m.owner as Unit)) return;
      if ((m.owner as Unit).w.rng() < iv(it, 'crit_chance') / 100) ev.critMult = Math.max(ev.critMult, iv(it, 'crit_multiplier') / 100);
    },
  }));
}
critItem('lesser_crit');
critItem('greater_crit');

function bashItem(key: string, extra: Partial<ItemImpl> = {}) {
  passiveItem(key, (it) => ({
    onAttackLanded(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (!real(u) || u.w.time < (it.data.bashReady ?? 0)) return;
      if (u.w.rng() >= (u.melee ? iv(it, 'bash_chance_melee') : iv(it, 'bash_chance_ranged')) / 100) return;
      it.data.bashReady = u.w.time + iv(it, 'bash_cooldown');
      // El bash hace daño físico extra.
      damage(u, t, iv(it, 'bonus_chance_damage'), 'physical', it, { noProc: true });
      stun(u, t, iv(it, 'bash_duration'), it);
      u.w.emit({ n: 'bash', x: t.x, y: t.y, u: t.id });
    },
  }), extra);
}
bashItem('basher');
bashItem('abyssal_blade', {
  target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  // Overwhelm atraviesa la inmunidad a debuffs.
  onSpellStart(it, t) { stunPierce(own(it), t.unit as Unit, iv(it, 'stun_duration'), it); },
});

function procItem(key: string) {
  passiveItem(key, (it) => ({
    onAttackStart(m, ev) {
      if (!real(m.owner as Unit)) return;
      if ((m.owner as Unit).w.rng() < iv(it, 'bonus_chance') / 100) { ev.trueStrike = true; (ev as any).proc = ((ev as any).proc ?? 0) + iv(it, 'bonus_chance_damage'); }
    },
    onAttackLanded(m, ev) {
      const p = (ev as any).proc;
      if (p) { (ev as any).proc = 0; damage(m.owner as Unit, ev.target as Unit, p, 'magical', it); }
    },
  }));
}
procItem('javelin');
procItem('monkey_king_bar');

/** Rayo encadenado de Maelstrom y Mjollnir. */
function chainLightning(u: Unit, first: Unit, dmgAmount: number, strikes: number, radius: number, it: ItemInst) {
  const hit = new Set<number>();
  let cur: Unit | null = first;
  let prev: Unit = u;
  for (let i = 0; i < strikes && cur; i++) {
    hit.add(cur.id);
    u.w.emit({ n: 'lightning', x: prev.x, y: prev.y, x2: cur.x, y2: cur.y });
    damage(u, cur, dmgAmount, 'magical', it, { noProc: true });
    prev = cur;
    cur = nearestEnemy(u, cur.x, cur.y, radius, hit);
  }
}
function chainItem(key: string, extra: Partial<ItemImpl> = {}) {
  passiveItem(key, (it) => ({
    onAttackLanded(m, ev) {
      const u = m.owner as Unit;
      if (!real(u) || u.w.time < (it.data.chainReady ?? 0)) return;
      if (u.w.rng() >= iv(it, 'chain_chance') / 100) return;
      it.data.chainReady = u.w.time + iv(it, 'chain_cooldown');
      chainLightning(u, ev.target as Unit, iv(it, 'chain_damage'), iv(it, 'chain_strikes'), iv(it, 'chain_radius'), it);
    },
  }), extra);
}
chainItem('maelstrom');
chainItem('mjollnir', {
  target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'buff' },
  onSpellStart(it, t) {
    const target = (t.unit as Unit) ?? own(it);
    target.addMod({
      name: 'static_charge', duration: iv(it, 'static_duration'), fx: 'static_charge',
      onAttacked(m, ev) {
        const u = m.owner as Unit;
        if (u.w.time < (m.data.ready ?? 0) || u.w.rng() >= iv(it, 'static_chance') / 100) return;
        m.data.ready = u.w.time + iv(it, 'static_cooldown');
        const targets = [ev.attacker as Unit, ...u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'static_radius')).filter((e) => e !== ev.attacker)]
          .slice(0, iv(it, 'static_strikes'));
        for (const e of targets) {
          u.w.emit({ n: 'lightning', x: u.x, y: u.y, x2: e.x, y2: e.y });
          damage(own(it), e, iv(it, 'static_damage'), 'magical', it, { noProc: true });
        }
      },
    }, own(it), it);
  },
});

// Desolator: Corruption y Soul Stealer (+daño por héroe enemigo que muere con Corruption).
passiveItem('desolator', (it) => ({
  props: () => ({ damage: it.data.souls ?? 0 }),
  onAttackLanded(m, ev) {
    const u = m.owner as Unit;
    (ev.target as Unit).addMod({ name: 'corruption', duration: iv(it, 'corruption_duration'), debuff: true, fx: 'corruption',
      props: { armor: iv(it, 'corruption_armor') } }, u, it);
  },
  onAnyDeath(m, victim, killer) {
    const u = m.owner as Unit;
    if (!real(u) || victim.kind !== 'hero' || victim.team === u.team || !victim.findMod('corruption', u)) return;
    const add = creditHero(killer as Unit | null) === u ? iv(it, 'bonus_damage_per_kill') : iv(it, 'bonus_damage_per_assist');
    it.data.souls = Math.min(iv(it, 'max_damage'), (it.data.souls ?? 0) + add);
    u.refreshStats();
  },
}));
passiveItem('skadi', (it) => ({
  onAttackLanded(m, ev) {
    const u = m.owner as Unit;
    const ms = u.melee ? iv(it, 'cold_slow_melee') : iv(it, 'cold_slow_ranged');
    const as = u.melee ? iv(it, 'cold_attack_slow_melee') : iv(it, 'cold_attack_slow_ranged');
    slow(u, ev.target as Unit, it, 'skadi_cold', iv(it, 'cold_duration'), ms / 100, as, { hpRegenAmp: -iv(it, 'restoration_reduction') / 100 });
  },
}));

/** Echo Strike (Echo Sabre, Harpoon): los cuerpo a cuerpo atacan dos veces seguidas. */
function echoStrike(it: ItemInst, ready: () => boolean, use: () => void): Partial<ModSpec> {
  return {
    onAttackLanded(m, ev) {
      const u = m.owner as Unit;
      if (!u.melee || !real(u) || ev.fake || !ready()) return;
      use();
      slow(u, ev.target as Unit, it, 'echo_slow', iv(it, 'slow_duration'), iv(it, 'movement_slow') / 100);
      u.w.after(0.1, () => { if (u.alive && (ev.target as Unit).alive) launchAttack(u, ev.target as Unit, true); });
    },
  };
}
passiveItem('echo_sabre', (it) => echoStrike(it, () => it.cd <= 0, () => { it.cd = it.def.cd; }));

/** Barrido en cono delante del atacante (Battle Fury). */
function cleaveCone(u: Unit, t: Unit, amount: number, pctHero: number, pctCreep: number, dist: number, w0: number, w1: number, it: ItemInst) {
  const ang = Math.atan2(t.y - u.y, t.x - u.x);
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, dist)) {
    if (e === t) continue;
    const rel = Math.atan2(e.y - u.y, e.x - u.x) - ang;
    const along = Math.hypot(e.x - u.x, e.y - u.y) * Math.cos(rel);
    const across = Math.abs(Math.hypot(e.x - u.x, e.y - u.y) * Math.sin(rel));
    const width = w0 + (w1 - w0) * (along / dist);
    const pct = e.kind === 'creep' ? pctCreep : pctHero;
    if (along > 0 && across <= width / 2) damage(u, e, amount * pct, 'physical', it, { noProc: true, hpRemoval: false, data: { cleave: true } });
  }
}
passiveItem('bfury', (it) => ({
  onAttackStart(_m, ev) {
    if (ev.target.kind === 'creep') ev.damage += own(it).melee ? iv(it, 'quelling_bonus') : iv(it, 'quelling_bonus_ranged');
  },
  onAttackLanded(m, ev) {
    const u = m.owner as Unit, t = ev.target as Unit;
    if (!u.melee || !real(u)) return;
    cleaveCone(u, t, ev.damage * ev.critMult, iv(it, 'cleave_damage_percent') / 100, iv(it, 'cleave_damage_percent_creep') / 100,
      iv(it, 'cleave_distance'), iv(it, 'cleave_starting_width'), iv(it, 'cleave_ending_width'), it);
  },
}), chopTree);

/** Manabreak (Diffusal, Disperser): quema maná y hace daño físico por maná quemado. */
function manaBreak(it: ItemInst): Partial<ModSpec> {
  return {
    onAttackLanded(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (!real(u) || t.s.maxMana <= 0) return;
      const b = burnMana(t, iv(it, 'feedback_mana_burn'));
      ev.damage += b * iv(it, 'damage_per_burn');
    },
  };
}
// Diffusal: Inhibit ya no disipa; ralentiza al 100% y decae en la duración.
passiveItem('diffusal_blade', manaBreak, {
  target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) { decayingSlow(own(it), t.unit as Unit, it, 'inhibit', iv(it, 'purge_slow_duration'), 1); },
});

// ---------------- Activas ----------------

/** Blink común: devuelve false si no se pudo. Recorta al 80% si se pide más allá del alcance. */
function doBlink(it: ItemInst, t: CastTarget) {
  const u = own(it);
  const tx = t.unit ? t.unit.x : t.x, ty = t.unit ? t.unit.y : t.y;
  let dx = tx - u.x, dy = ty - u.y;
  const d = Math.hypot(dx, dy) || 1;
  const max = iv(it, 'blink_range') + u.s.castRange;
  const go = d > max ? iv(it, 'blink_range_clamp') : d;
  dx /= d; dy /= d;
  const fx = u.x, fy = u.y;
  u.w.disjoint(u);
  u.w.teleport(u, u.x + dx * go, u.y + dy * go);
  u.w.emit({ n: 'blink', x: fx, y: fy, x2: u.x, y2: u.y, u: u.id });
}
const blinkCheck = (it: ItemInst) => (own(it).w.time - own(it).lastHeroDamageAt < iv(it, 'blink_damage_cooldown') ? 'Blink desactivado por daño' : null);
defineItem({
  key: 'blink', target: 'point', castBeyond: true, castRange: cr, ai: { role: 'escape' },
  check: blinkCheck,
  onSpellStart(it, t) { doBlink(it, t); },
});
/** Blinks mejorados: también aceptan una unidad (se teletransporta a su posición). */
function blinkPlus(key: string, role: string, after: (it: ItemInst, u: Unit) => void, passive?: (it: ItemInst) => Omit<ModSpec, 'name'>) {
  defineItem({
    key, target: 'unitOrPoint', team: 'any', allowSelf: true, castBeyond: true, castRange: cr, ai: { role },
    check: blinkCheck,
    passive: passive ? (it) => ({ name: 'p_' + key, ...passive(it) }) : undefined,
    onSpellStart(it, t) { doBlink(it, t); after(it, own(it)); },
  });
}
blinkPlus('overwhelming_blink', 'nuke', (it, u) => {
  const r = iv(it, 'radius'), dur = iv(it, 'duration');
  u.w.emit({ n: 'overwhelming_blink', x: u.x, y: u.y, r, t: u.team });
  const str = u.s.str;
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
    damage(u, e, iv(it, 'damage_base') + str * iv(it, 'damage_pct_instant') / 100, 'magical', it);
    const dps = str * iv(it, 'damage_pct_over_time') / 100 / dur;
    debuff(u, e, it, {
      name: 'overwhelming_blink', duration: dur, fx: 'slow', interval: 1,
      props: { msSlow: iv(it, 'movement_slow') / 100, attackSlow: iv(it, 'attack_slow') },
      onInterval(m) { damage(u, m.owner as Unit, dps, 'magical', it, { noProc: true }); },
    });
  }
});
// Swift: bonus_movement es de la activa, no pasivo (sim/items.ts lo suma como plano).
blinkPlus('swift_blink', 'nuke', (it, u) => {
  u.addMod({ name: 'swift_blink', duration: iv(it, 'duration'), fx: 'haste', states: ST.noCollision,
    props: { msPct: iv(it, 'bonus_movement') / 100, agi: iv(it, 'bonus_agi_active') } }, u, it);
}, (it) => ({ props: { msFlat: -iv(it, 'bonus_movement') } }));
blinkPlus('arcane_blink', 'heal', (it, u) => {
  heal(u, iv(it, 'heal_amount'));
  giveMana(u, iv(it, 'mana_amount'));
});

// BKB: cada uso dura menos (9/8/7 s).
defineItem({
  key: 'black_king_bar', target: 'none', ai: { role: 'bkb', selfRadius: 700 },
  onSpellStart(it) {
    const u = own(it);
    const uses = it.data.uses ?? 0;
    it.data.uses = Math.min(iv(it, 'max_level') - 1, uses + 1);
    u.purge(true, false);
    u.addMod({ name: 'avatar', duration: lv(it.def.values.duration, uses + 1), fx: 'bkb', states: ST.magicImmune,
      props: { magicResist: iv(it, 'spell_reduce') / 100 } }, u, it);
  },
});

defineItem({
  key: 'force_staff', target: 'unit', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'escape' },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    if (e.team !== own(it).team && !canDebuff(own(it), e, it)) return;
    e.w.disjoint(e);
    push(e, Math.cos(e.facing), Math.sin(e.facing), iv(it, 'push_length'), iv(it, 'push_time'), own(it), it, 'force_staff');
  },
});

/** Ciclón de Eul's y Wind Waker. Con `selfMove`, en uno mismo se puede mover el tornado. */
function cycloneOn(it: ItemInst, e: Unit, selfMove: boolean) {
  const u = own(it);
  const enemy = e.team !== u.team;
  if (enemy && !canDebuff(u, e, it)) return;
  if (!enemy) e.purge(true, false); else e.purge(false, true);
  if (e.cast) e.w.interruptCast(e, true);
  e.w.disjoint(e);
  const moving = selfMove && e === u;
  e.addMod({
    name: 'cyclone', duration: iv(it, 'cyclone_duration'), debuff: enemy, purgable: false, fx: 'cyclone',
    states: ST.invulnerable | ST.untargetable | (moving ? ST.disarmed | ST.silenced | ST.muted | ST.noCollision : ST.stunned),
    props: moving ? { msFixed: iv(it, 'tornado_speed') } : undefined,
    onDestroy(m) { if (enemy) damage(u, m.owner as Unit, iv(it, 'tooltip_drop_damage'), 'magical', it); },
  }, u, it);
}
defineItem({
  key: 'cyclone', target: 'unit', team: 'any', allowSelf: true, castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    // Eul's: solo en uno mismo o en enemigos.
    if (e.team === u.team && e !== u) { refund(it, 'Solo en ti o en enemigos'); return; }
    cycloneOn(it, e, false);
  },
});
defineItem({
  key: 'wind_waker', target: 'unit', team: 'any', allowSelf: true, castRange: cr, reflectable: true, ai: { role: 'escape' },
  onSpellStart(it, t) { cycloneOn(it, (t.unit as Unit) ?? own(it), true); },
});

defineItem({
  key: 'sheepstick', target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) { hex(own(it), t.unit as Unit, iv(it, 'sheep_duration'), it, iv(it, 'sheep_movement_speed')); },
});

function silenceItem(key: string) {
  const bt = key === 'bloodthorn';
  defineItem({
    key, target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
    passive: bt ? (it) => ({
      name: 'p_bloodthorn_proc',
      // Pierce: probabilidad de True Strike con daño mágico extra; además True Strike contra el silenciado.
      onAttackStart(m, ev) {
        const u = m.owner as Unit;
        if ((ev.target as Unit).findMod('soul_burn', u)) ev.trueStrike = true;
        if (!real(u) || u.w.rng() >= iv(it, 'proc_chance') / 100) return;
        ev.trueStrike = true;
        (ev as any).btProc = true;
      },
      onAttackLanded(m, ev) {
        if (!(ev as any).btProc) return;
        (ev as any).btProc = false;
        damage(m.owner as Unit, ev.target as Unit, iv(it, 'passive_proc_damage'), 'magical', it, { noProc: true });
      },
    }) : undefined,
    onSpellStart(it, t) {
      const u = own(it), e = t.unit as Unit;
      const m = silence(u, e, iv(it, 'silence_duration'), it, 'soul_burn');
      if (!m) return;
      m.data.taken = 0;
      m.onTakeDamage = (mm, ev) => { mm.data.taken += ev.amount; };
      m.onDestroy = (mm) => {
        const extra = mm.data.taken * iv(it, 'silence_damage_percent') / 100;
        if (extra > 0) damage(u, mm.owner as Unit, extra, 'magical', it, { noProc: true });
      };
      // Bloodthorn: los ataques al silenciado hacen daño extra.
      if (bt) m.onAttacked = (_mm, ev) => { ev.damage += (ev.attacker as Unit).isHeroLike ? iv(it, 'proc_damage_heroes') : iv(it, 'proc_damage_creeps'); };
    },
  });
}
silenceItem('orchid');
silenceItem('bloodthorn');

for (const k of ['dagon', 'dagon_2', 'dagon_3', 'dagon_4', 'dagon_5']) {
  defineItem({
    key: k, target: 'unit', reflectable: true, castRange: cr, ai: { role: 'nuke' },
    onSpellStart(it, t) {
      const u = own(it), e = t.unit as Unit;
      u.w.emit({ n: 'dagon', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id, v: itemLevel(k) });
      damage(u, e, iv(it, 'damage'), 'magical', it);
    },
  });
}

/**
 * Forma etérea. El motor amplifica el daño mágico a etéreos un 40%; los items de 7.39
 * lo dejan en extra_spell_damage_percent / ethereal_damage_bonus (−30 → +30%): se corrige aquí.
 */
function etherealMod(it: ItemInst, duration: number, enemy: boolean, ampKey: string, slowKey?: string): ModSpec {
  const amp = 1 + Math.abs(iv(it, ampKey)) / 100;
  return {
    name: 'ethereal', duration, debuff: enemy, fx: 'ethereal',
    states: ST.ethereal | ST.disarmed,
    props: enemy && slowKey ? { msSlow: Math.abs(iv(it, slowKey)) / 100 } : {},
    onIncomingDamage(_m, ev) { if (ev.type === 'magical' && !ev.hpRemoval) ev.amount *= amp / 1.4; },
  };
}
defineItem({
  key: 'ghost', target: 'none', ai: { role: 'escape' },
  onSpellStart(it) { own(it).addMod(etherealMod(it, iv(it, 'duration'), false, 'extra_spell_damage_percent'), own(it), it); },
});
defineItem({
  key: 'ethereal_blade', target: 'unit', team: 'any', allowSelf: true, castRange: cr, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    const enemy = e.team !== u.team;
    u.w.addProjectile({
      kind: 'track', fx: 'ethereal', source: u, target: e, x: u.x, y: u.y, speed: iv(it, 'projectile_speed'),
      onHit() {
        if (enemy && !canDebuff(u, e, it)) return true;
        e.addMod(etherealMod(it, enemy ? iv(it, 'duration') : iv(it, 'duration_ally'), enemy, 'ethereal_damage_bonus', 'blast_movement_slow'), u, it);
        if (enemy) {
          const primary = u.hero?.attr === 'all' ? (u.s.str + u.s.agi + u.s.int) * 0.45
            : u.hero?.attr === 'str' ? u.s.str : u.hero?.attr === 'agi' ? u.s.agi : u.s.int;
          damage(u, e, iv(it, 'blast_damage_base') + primary * iv(it, 'blast_stat_multiplier'), 'magical', it);
        }
        return true;
      },
    });
  },
});

defineItem({
  key: 'manta', target: 'none', ai: { role: 'escape', selfRadius: 600 },
  onSpellStart(it) {
    const u = own(it);
    u.purge(true, false);
    u.w.disjoint(u);
    const out = (u.melee ? iv(it, 'images_do_damage_percent_melee') : iv(it, 'images_do_damage_percent_ranged')) / 100;
    const inc = iv(it, 'images_take_damage_percent') / 100;
    const phase = iv(it, 'invuln_duration');
    u.addMod({ name: 'manta_phase', duration: phase, states: ST.invulnerable | ST.hidden | ST.untargetable }, u, it);
    u.w.after(phase, () => {
      if (!u.alive) return;
      const n = iv(it, 'images_count') + 1;
      const spots = Array.from({ length: n }, (_, i) => {
        const ang = u.facing + Math.PI / 2 + i * (2 * Math.PI / n);
        return [u.x + Math.cos(ang) * 100, u.y + Math.sin(ang) * 100];
      });
      // El héroe acaba en un sitio al azar entre todos.
      const k = Math.floor(u.w.rng() * n);
      const [hx, hy] = spots[k];
      for (let i = 0; i < n; i++) {
        if (i === k) continue;
        const il = u.w.spawnIllusion(u, spots[i][0], spots[i][1], iv(it, 'illusion_duration'), out, inc);
        if (u.order) u.w.issueOrder(il, { ...u.order } as any);
      }
      u.w.teleport(u, hx, hy);
    });
  },
});

defineItem({
  key: 'mekansm', target: 'none', ai: { role: 'heal' },
  passive: (it) => ({ name: 'p_mekansm', aura: auraSpec(it, 'mekansm_aura', iv(it, 'aura_radius'), 'ally', { hpRegen: iv(it, 'aura_health_regen') }) }),
  onSpellStart(it) {
    const u = own(it);
    u.w.emit({ n: 'mekansm', x: u.x, y: u.y, r: iv(it, 'heal_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'heal_radius'))) if (a.isHeroLike) heal(a, iv(it, 'heal_amount'));
  },
});
// Guardian Greaves: la aura sube la regeneración de quien esté por debajo del 25% de vida.
defineItem({
  key: 'guardian_greaves', target: 'none', ai: { role: 'heal' },
  passive: (it) => ({
    name: 'p_greaves',
    aura: auraSpec(it, 'greaves_aura', iv(it, 'aura_radius'), 'ally', (m) => {
      const t = m.owner as Unit;
      const low = t.hp < t.s.maxHp * iv(it, 'aura_bonus_threshold') / 100;
      return { hpRegen: low ? iv(it, 'aura_health_regen_bonus') : iv(it, 'aura_health_regen'), manaRegen: iv(it, 'aura_mana_regen') };
    }, refreshEvery(0.25)),
  }),
  onSpellStart(it) {
    const u = own(it);
    u.purge(true, false);
    u.w.emit({ n: 'mekansm', x: u.x, y: u.y, r: iv(it, 'replenish_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'replenish_radius'))) if (a.isHeroLike) { heal(a, iv(it, 'replenish_health')); giveMana(a, iv(it, 'replenish_mana')); }
  },
});

defineItem({
  key: 'pipe', target: 'none', ai: { role: 'barrier', selfRadius: 900 },
  passive: (it) => ({ name: 'p_pipe', aura: auraSpec(it, 'pipe_aura', iv(it, 'aura_radius'), 'ally', { magicResist: iv(it, 'magic_resistance_aura') / 100 }) }),
  onSpellStart(it) {
    const u = own(it);
    u.w.emit({ n: 'pipe', x: u.x, y: u.y, r: iv(it, 'barrier_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'barrier_radius'))) {
      const amt = a.isHeroLike ? iv(it, 'barrier_block') : iv(it, 'barrier_block_creep');
      a.addMod({ name: 'pipe_barrier', duration: iv(it, 'barrier_duration'), fx: 'barrier', ...magicBarrier(amt) }, u, it);
    }
  },
});

function invisMod(name: string, duration: number, props: Partial<Props>, bonusDamage = 0, extra: Partial<ModSpec> = {}): ModSpec {
  return {
    name, duration, fx: 'invis', states: ST.invisible | ST.noCollision, props,
    data: { breaksOnAttack: true, ...(extra.data ?? {}) },
    onAttackStart(_m, ev) { ev.damage += bonusDamage; },
    ...extra,
  };
}
function fadeInto(u: Unit, delay: number, spec: ModSpec, src: Unit, it: ItemInst) {
  u.w.emit({ n: 'fade', x: u.x, y: u.y, u: u.id });
  u.w.after(delay, () => { if (u.alive) u.addMod(spec, src, it); });
}
defineItem({
  key: 'shadow_amulet', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'escape' },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    fadeInto(e, iv(it, 'fade_time'), invisMod('fade', iv(it, 'fade_duration'), { msPct: -iv(it, 'movement_speed_reduction') / 100 }), own(it), it);
  },
});
defineItem({
  key: 'glimmer_cape', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'escape' },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    e.addMod({ name: 'glimmer_barrier', duration: iv(it, 'duration') + iv(it, 'initial_fade_delay'), fx: 'barrier', ...magicBarrier(iv(it, 'barrier_block')) }, own(it), it);
    fadeInto(e, iv(it, 'initial_fade_delay'), invisMod('glimmer', iv(it, 'duration'), { msPct: iv(it, 'active_movement_speed') / 100 }), own(it), it);
  },
});
function windwalkItem(key: string) {
  const se = key === 'silver_edge';
  defineItem({
    key, target: 'none', ai: { role: 'escape' },
    // Silver Edge: el golpe que rompe la invisibilidad aplica Break y limita la velocidad.
    passive: se ? (it) => ({
      name: 'p_silver_edge_backstab',
      onAttackLanded(m, ev) {
        if (!(ev as any).backstab) return;
        const u = m.owner as Unit, t = ev.target as Unit;
        debuff(u, t, it, { name: 'silver_edge_break', duration: iv(it, 'backstab_duration'), fx: 'break',
          states: ST.broken, props: { msFixed: iv(it, 'max_movement_speed') } });
      },
    }) : undefined,
    onSpellStart(it) {
      const u = own(it);
      const bonus = iv(it, 'windwalk_bonus_damage');
      fadeInto(u, iv(it, 'windwalk_fade_time'),
        invisMod('shadow_walk', iv(it, 'windwalk_duration'), { msPct: iv(it, 'windwalk_movement_speed') / 100 }, bonus, {
          onAttackStart(_m, ev) { ev.damage += bonus; if (se) (ev as any).backstab = true; },
        }), u, it);
    },
  });
}
windwalkItem('invis_sword');
windwalkItem('silver_edge');

defineItem({
  key: 'satanic', target: 'none', ai: { role: 'buff', selfRadius: 300 },
  onSpellStart(it) {
    const u = own(it);
    u.purge(true, false);
    u.addMod({ name: 'unholy_rage', duration: iv(it, 'unholy_duration'), fx: 'satanic',
      props: { lifesteal: iv(it, 'unholy_lifesteal_percent') / 100 } }, u, it);
  },
});

defineItem({
  key: 'armlet', target: 'toggle',
  onToggle(it, on) {
    const u = own(it);
    if (!on) { u.removeModsByName('unholy_strength'); return; }
    u.addMod({
      name: 'unholy_strength', fx: 'armlet', interval: 0.1,
      props: { damage: iv(it, 'unholy_bonus_damage'), str: iv(it, 'unholy_bonus_strength'), armor: iv(it, 'unholy_bonus_armor'),
        slowResist: iv(it, 'unholy_bonus_slow_resistance') / 100 },
      onInterval(m) { damage(null, m.owner as Unit, iv(it, 'unholy_health_drain_per_second') * 0.1, 'pure', it, { hpRemoval: true, noProc: true, data: { nonLethal: true } }); },
    }, u, it);
  },
});

defineItem({
  key: 'power_treads', target: 'toggle',
  passive: (it) => ({
    name: 'p_treads',
    props: () => {
      const s = iv(it, 'bonus_stat');
      return {
        str: it.mode === 0 ? s : 0, agi: it.mode === 1 ? s : 0, int: it.mode === 2 ? s : 0,
        msFlat: own(it).melee ? iv(it, 'bonus_movement_speed_melee') : iv(it, 'bonus_movement_speed_ranged'),
      };
    },
  }),
  onToggle(it) { it.mode = (it.mode + 1) % 3; it.toggled = false; own(it).refreshStats(); },
});

defineItem({
  key: 'phase_boots', target: 'none', ai: { role: 'chase' },
  passive: (it) => ({ name: 'p_phase', props: { damage: own(it).melee ? iv(it, 'bonus_damage_melee') : iv(it, 'bonus_damage_range') } }),
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'phase', duration: iv(it, 'phase_duration'), fx: 'haste', states: ST.noCollision,
      props: { msPct: (u.melee ? iv(it, 'phase_movement_speed') : iv(it, 'phase_movement_speed_range')) / 100 } }, u, it);
  },
});

// Midas: cargas que se recargan; mata un creep no ancestral por oro (sin experiencia en 7.39).
defineItem({
  key: 'hand_of_midas', target: 'unit', castRange: cr, ai: { role: 'midas' },
  check: needCharges,
  passive: (it) => ({ name: 'p_midas', interval: 0.5, onInterval() { chargeRegen(it, iv(it, 'abilitycharges'), iv(it, 'abilitychargerestoretime')); } }),
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    if (e.kind !== 'creep' || /ancient/.test(e.name)) { refund(it, 'Solo sobre creeps no ancestrales'); return; }
    it.charges--;
    u.gold += iv(it, 'bonus_gold');
    u.w.emit({ n: 'midas', x: e.x, y: e.y, v: iv(it, 'bonus_gold'), u: e.id });
    damage(u, e, e.hp + 1, 'pure', it, { hpRemoval: true });
  },
});

// Soul Ring: maná temporal; lo que no se gaste se pierde al acabar.
defineItem({
  key: 'soul_ring', target: 'none', ai: { role: 'mana' },
  onSpellStart(it) {
    const u = own(it);
    damage(null, u, iv(it, '_hc'), 'pure', it, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
    const before = u.mana;
    giveMana(u, iv(it, 'mana_gain'));
    u.addMod({
      name: 'soul_ring_mana', duration: iv(it, 'duration'), fx: 'soul_ring',
      data: { buffer: u.mana - before, prev: u.mana },
      onTick(m) {
        const o = m.owner as Unit;
        if (o.mana < m.data.prev) m.data.buffer = Math.max(0, m.data.buffer - (m.data.prev - o.mana));
        m.data.prev = o.mana;
      },
      onDestroy(m) { const o = m.owner as Unit; o.mana = Math.max(0, o.mana - m.data.buffer); },
    }, u, it);
  },
});

defineItem({
  key: 'mask_of_madness', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'berserk', duration: iv(it, 'berserk_duration'), fx: 'berserk', states: ST.silenced,
      props: {
        attackSpeed: iv(it, 'berserk_bonus_attack_speed'),
        msPct: (u.melee ? iv(it, 'berserk_bonus_movement_speed_melee') : iv(it, 'berserk_bonus_movement_speed')) / 100,
        armor: -iv(it, 'berserk_armor_reduction'),
        slowResist: (u.melee ? iv(it, 'berserk_slow_resist_melee') : iv(it, 'berserk_slow_resist')) / 100,
      } }, u, it);
  },
});

defineItem({
  key: 'blade_mail', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  passive: (it) => ({
    name: 'p_blade_mail',
    onTakeDamage(m, ev) {
      const u = m.owner as Unit, s = ev.source as Unit | null;
      if (!s || s.team === u.team || ev.noProc || !ev.isAttack || ev.data?.reflected) return;
      damage(u, s, iv(it, 'passive_reflection_constant') + ev.amount * iv(it, 'passive_reflection_pct') / 100, 'physical', it,
        { noProc: true, data: { reflected: true } });
    },
  }),
  onSpellStart(it) {
    const u = own(it);
    u.addMod({
      name: 'blade_mail_active', duration: iv(it, 'duration'), fx: 'blade_mail',
      onTakeDamage(_m, ev) {
        const s = ev.source as Unit | null;
        if (!s || s.team === u.team || ev.data?.reflected || ev.hpRemoval) return;
        damage(u, s, ev.amount * iv(it, 'active_reflection_pct') / 100, ev.type, it, { noProc: true, data: { reflected: true } });
      },
    }, u, it);
  },
});

defineItem({
  key: 'shivas_guard', target: 'none', ai: { role: 'aoe', selfRadius: 700 },
  passive: (it) => ({ name: 'p_shivas', aura: auraSpec(it, 'shivas_aura', iv(it, 'aura_radius'), 'enemy', { attackSlow: Math.abs(iv(it, 'aura_attack_speed')) }) }),
  onSpellStart(it) {
    const u = own(it);
    const r = iv(it, 'blast_radius');
    u.w.emit({ n: 'shivas', x: u.x, y: u.y, r, d: r / iv(it, 'blast_speed'), t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      const delay = Math.hypot(e.x - u.x, e.y - u.y) / iv(it, 'blast_speed');
      u.w.after(delay, () => {
        if (!e.alive) return;
        damage(u, e, iv(it, 'blast_damage'), 'magical', it);
        slow(u, e, it, 'shivas_blast', iv(it, 'blast_debuff_duration'), iv(it, 'blast_movement_speed') / 100);
      });
    }
  },
});

defineItem({
  key: 'rod_of_atos', target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  passive: (it) => ({ name: 'p_atos', props: { hp: iv(it, 'bonus_hp') } }),
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'atos', source: u, target: e, x: u.x, y: u.y, speed: 1900, dodgeable: true,
      onHit() { root(u, e, iv(it, 'duration'), it, 'cripple'); return true; },
    });
  },
});

defineItem({
  key: 'refresher', target: 'none', ai: { role: 'refresh' },
  onSpellStart(it) {
    const u = own(it);
    for (const a of u.abilities) { a.cd = 0; if (a.impl.charges && a.level > 0) a.charges = a.impl.charges(a)[0]; }
    for (const i of u.items) if (i && i !== it && i.key !== 'refresher') i.cd = 0;
    u.w.emit({ n: 'refresher', x: u.x, y: u.y, u: u.id });
  },
});

/** Bloqueo de hechizos de Linken (en el dueño o transferido a un aliado). */
function spellblock(ready: () => boolean, use: () => void): Partial<ModSpec> {
  return {
    onTargeted(m, caster) {
      const u = m.owner as Unit;
      if (!ready() || caster.team === u.team) return false;
      use();
      u.w.emit({ n: 'linkens', x: u.x, y: u.y, u: u.id });
      return true;
    },
  };
}
defineItem({
  key: 'sphere', target: 'unit', team: 'ally', castRange: cr,
  passive: (it) => ({ name: 'p_sphere', fx: 'linkens', ...spellblock(() => it.cd <= 0, () => { it.cd = iv(it, 'block_cooldown'); }) }),
  // Transfer Spellblock: el dueño pierde el bloqueo (enfriamiento) y lo lleva el aliado.
  onSpellStart(it, t) {
    const e = t.unit as Unit;
    if (!e || e === own(it)) { refund(it, 'Tiene que ser otro aliado'); return; }
    e.addMod({ name: 'sphere_target', duration: it.def.cd, fx: 'linkens',
      ...spellblock(() => true, () => { e.removeModsByName('sphere_target'); }) }, own(it), it);
  },
});

defineItem({
  key: 'lotus_orb', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'buff' },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    e.purge(true, false);
    e.addMod({
      name: 'echo_shell', duration: iv(it, 'active_duration'), fx: 'lotus',
      onTargeted(m, caster, spell) { reflectSpell(m.owner as Unit, caster as Unit, spell); return false; },
    }, own(it), it);
  },
});

// =====================================================================
// Items nuevos
// =====================================================================

// ---------------- Consumibles y utilidades ----------------

// Moon Shard: en el inventario da velocidad de ataque y visión nocturna; consumido, la mitad.
function nightVision(u: Unit, v: number) { return u.w.isNight() ? v : 0; }
defineItem({
  key: 'moon_shard', target: 'unit', team: 'ally', allowSelf: true, castRange: () => 250,
  // Es "consumible" para el dataset, así que sim/items.ts no le pone stats.
  passive: (it) => ({
    name: 'p_moon_shard', ...refreshEvery(1),
    props: (m) => ({ attackSpeed: iv(it, 'bonus_attack_speed'), vision: nightVision(m.owner as Unit, iv(it, 'bonus_night_vision')) }),
  }),
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    if (!e.isHero) { refund(it, 'Solo en héroes'); return; }
    if (e.findMod('moon_shard_consumed')) { refund(it, 'Ya ha consumido un Moon Shard'); return; }
    e.addMod({
      name: 'moon_shard_consumed', persistent: true, purgable: false, ...refreshEvery(1),
      props: (m) => ({ attackSpeed: iv(it, 'consumed_bonus'), vision: nightVision(m.owner as Unit, iv(it, 'consumed_bonus_night_vision')) }),
    }, e, null);
    consume(it);
  },
});

// Gem: True Sight en 900; la activa revela una zona pequeña unos segundos.
defineItem({
  key: 'gem', target: 'point', castRange: cr,
  passive: (it) => ({ name: 'p_gem', props: { trueSight: iv(it, 'radius') } }),
  onSpellStart(it, t) {
    const u = own(it), r = iv(it, 'active_radius'), dur = iv(it, 'duration');
    u.w.addVision(u.team, t.x, t.y, r, dur);
    u.w.addZone({
      fx: 'gem', x: t.x, y: t.y, r, team: u.team, interval: 0.1, duration: dur,
      onInterval(z) {
        for (const e of u.w.unitsIn(z.x, z.y, z.r, (x) => x.team !== u.team && x.has(ST.invisible))) {
          e.addMod({ name: 'reveal', duration: 0.2, debuff: true, states: ST.revealed, data: { team: u.team } }, u, it);
        }
      },
    });
  },
});

// Blood Grenade: cuesta vida, cae en un área tras volar y deja veneno y ralentizado.
defineItem({
  key: 'blood_grenade', target: 'unitOrPoint', team: 'any', allowSelf: true, consumable: true, castRange: cr,
  castPoint: lv(ITEMS.blood_grenade?.values.abilitycastpoint, 1), ai: { role: 'nuke' },
  passive: (it) => ({ name: 'p_blood_grenade', props: { hp: iv(it, 'bonus_health') } }),
  onSpellStart(it, t) {
    const u = own(it);
    const x = t.unit ? t.unit.x : t.x, y = t.unit ? t.unit.y : t.y;
    damage(null, u, iv(it, '_hc'), 'pure', it, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
    const r = iv(it, 'radius');
    const delay = Math.hypot(x - u.x, y - u.y) / iv(it, 'speed');
    const v = { impact: iv(it, 'impact_damage'), dot: iv(it, 'damage_over_time'), tick: iv(it, 'tick_rate'), dur: iv(it, 'debuff_duration'), ms: iv(it, 'movespeed_slow') };
    u.w.emit({ n: 'blood_grenade', x: u.x, y: u.y, x2: x, y2: y, d: delay });
    u.w.after(delay, () => {
      u.w.emit({ n: 'aoe', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        if (!canDebuff(u, e, it)) continue;
        damage(u, e, v.impact, 'magical', it);
        debuff(u, e, it, {
          name: 'blood_grenade', duration: v.dur, fx: 'slow', interval: v.tick,
          props: { msSlow: Math.abs(v.ms) / 100 },
          onInterval(m) { damage(u, m.owner as Unit, v.dot * v.tick, 'magical', it, { noProc: true }); },
        });
      }
    });
    useCharge(it);
  },
});

// Bottle: cargas de regeneración que se rellenan en la fuente.
defineItem({
  key: 'bottle', target: 'none', ai: { role: 'heal' },
  check: needCharges,
  passive: (it) => ({
    name: 'p_bottle', interval: 0.5,
    onInterval(m) { if (atShop(m.owner as Unit)) it.charges = iv(it, 'max_charges'); },
  }),
  onSpellStart(it) {
    const u = own(it);
    const time = iv(it, 'restore_time');
    const hp = iv(it, 'health_restore') / time, mp = iv(it, 'mana_restore') / time;
    it.charges--;
    u.addMod({
      name: 'bottle_regen', duration: time, fx: 'bottle', props: { hpRegen: hp, manaRegen: mp },
      onTakeDamage(m, ev) {
        const s = ev.source as Unit | null;
        if (ev.isAttack && s && s.team !== u.team && s.isHeroLike) (m.owner as Unit).removeMod(m);
      },
    }, u, it);
  },
});

// Sentry Ward: ward invisible que da True Sight a la visión aliada.
defineItem({
  key: 'ward_sentry', target: 'point', consumable: true, castRange: cr,
  onSpellStart(it, t) {
    const u = own(it);
    const ward = u.w.spawnSummon(u, 'sentry_wards', t.x, t.y, iv(it, 'lifetime'), { kind: 'ward', hp: iv(it, 'health') });
    ward.addMod({
      name: 'sentry_ward', persistent: true, purgable: false,
      states: ST.invisible | ST.busy | ST.rooted | ST.disarmed | ST.noCollision,
      props: { trueSight: iv(it, 'true_sight_range'), vision: iv(it, 'vision_range') },
    }, u, it);
    useCharge(it);
  },
});

// Smoke of Deceit: invisibilidad de grupo que se rompe cerca de héroes enemigos.
defineItem({
  key: 'smoke_of_deceit', target: 'none', consumable: true,
  onSpellStart(it) {
    const u = own(it);
    const applied = new Set<number>();
    const visR = iv(it, 'visibility_radius');
    const spec = (src: boolean): ModSpec => ({
      name: 'smoke_of_deceit', duration: iv(it, 'duration'), fx: 'smoke', states: ST.invisible,
      props: { msPct: iv(it, 'bonus_movement_speed') / 100 },
      data: { breaksOnAttack: true }, interval: 0.2,
      onInterval(m) {
        const o = m.owner as Unit;
        if (o.w.enemiesIn(o.team, o.x, o.y, visR, { heroes: true }).some((e) => e.isHero)) { m.data.breakNow = true; return; }
        // Mientras el que la usó siga camuflado, los aliados que se acerquen también la reciben.
        if (!src) return;
        for (const a of o.w.alliesIn(o.team, o.x, o.y, iv(it, 'secondary_application_radius'), { heroes: true })) {
          if (applied.has(a.id)) continue;
          applied.add(a.id);
          a.addMod(spec(false), u, it);
        }
      },
    });
    u.w.emit({ n: 'smoke', x: u.x, y: u.y, r: iv(it, 'application_radius'), t: u.team });
    for (const a of u.w.unitsIn(u.x, u.y, iv(it, 'application_radius'), (x) => x.team === u.team && (x.isHeroLike || (x.kind === 'summon' && !!x.owner)))) {
      applied.add(a.id);
      a.addMod(spec(a === u), u, it);
    }
    useCharge(it);
  },
});

// ---------------- Pasivas con "Empower Spell" y "Witch Blade" ----------------

/** Phylactery y Angel's Demise: el siguiente hechizo con objetivo enemigo hace daño extra. */
function empowerSpell(key: string, breaks: boolean) {
  passiveItem(key, (it) => ({
    onAbilityExecuted(m, a) {
      const u = m.owner as Unit;
      if (isItem(a) || it.cd > 0 || !real(u)) return;
      if (a.impl.target !== 'unit' && a.impl.target !== 'unitOrPoint') return;
      const e = u.cast?.tu ? u.w.units.get(u.cast.tu) : undefined;
      if (!e || e.team === u.team || !e.alive) return;
      it.cd = it.def.cd;
      u.w.emit({ n: key, x: e.x, y: e.y, u: e.id });
      damage(u, e, iv(it, 'bonus_spell_damage'), 'magical', it);
      debuff(u, e, it, { name: key + '_slow', duration: iv(it, 'slow_duration'), fx: 'slow',
        states: breaks ? ST.broken : 0, props: { msSlow: iv(it, 'slow') / 100 } });
    },
  }));
}
empowerSpell('phylactery', false);
empowerSpell('angels_demise', true);

/** Witch Blade y Devastator: el siguiente ataque tiene True Strike y envenena según la inteligencia. */
function witchBlade(it: ItemInst, key: string): Partial<ModSpec> {
  return {
    onAttackStart(m, ev) {
      if (!real(m.owner as Unit) || it.cd > 0 || ev.fake || ev.target.kind === 'ward') return;
      it.cd = it.def.cd;
      ev.trueStrike = true;
      (ev as any)[key] = true;
    },
    onAttackLanded(m, ev) {
      if (!(ev as any)[key]) return;
      const u = m.owner as Unit, t = ev.target as Unit;
      const dps = u.s.int * iv(it, 'int_damage_multiplier');
      debuff(u, t, it, {
        name: key + '_poison', duration: iv(it, 'slow_duration'), fx: 'poison', interval: 1,
        props: { msSlow: iv(it, 'slow') / 100 },
        onInterval(mm) { damage(u, mm.owner as Unit, dps, 'magical', it, { noProc: true }); },
      });
    },
  };
}
passiveItem('witch_blade', (it) => witchBlade(it, 'witch_blade'));
passiveItem('devastator', (it) => {
  const wb = witchBlade(it, 'devastator');
  return {
    ...wb,
    onAttackLanded(m, ev) {
      wb.onAttackLanded!(m, ev);
      // Magic Corruption: baja la resistencia mágica.
      debuff(m.owner as Unit, ev.target as Unit, it, { name: 'devastator_corruption', duration: iv(it, 'slow_duration'), fx: 'corruption',
        props: { magicResist: -iv(it, 'active_mres_reduction') / 100 } });
    },
  };
});

// ---------------- Orbes de ataque ----------------

passiveItem('orb_of_venom', (it) => ({
  onAttackLanded(m, ev) {
    const u = m.owner as Unit;
    debuff(u, ev.target as Unit, it, {
      name: 'orb_of_venom', duration: iv(it, 'poison_duration'), fx: 'poison', interval: iv(it, 'tick_interval'),
      onInterval(mm) { damage(u, mm.owner as Unit, iv(it, 'damage') * iv(it, 'tick_interval'), 'magical', it, { noProc: true }); },
    });
  },
}));
passiveItem('blight_stone', (it) => ({
  onAttackLanded(m, ev) {
    const t = ev.target as Unit;
    if (t.findMod('corruption')) return; // Desolator es más fuerte y no se acumula
    t.addMod({ name: 'lesser_corruption', duration: iv(it, 'corruption_duration'), debuff: true, fx: 'corruption',
      props: { armor: iv(it, 'corruption_armor') } }, m.owner as Unit, it);
  },
}));
/** Orb of Frost y Orb of Corrosion: ralentizado (menor contra cuerpo a cuerpo) y menos curación. */
function frostOrb(key: string, armor: boolean) {
  passiveItem(key, (it) => ({
    onAttackLanded(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      const ms = Math.abs(t.melee ? iv(it, 'slow_melee') : iv(it, 'slow_ranged')) / 100;
      debuff(u, t, it, {
        name: key, duration: iv(it, 'duration'), fx: 'slow',
        props: { msSlow: ms, hpRegenAmp: -iv(it, 'heal_reduction') / 100, ...(armor ? { armor: iv(it, 'corruption_armor') } : {}) },
      });
    },
  }));
}
frostOrb('orb_of_frost', false);
frostOrb('orb_of_corrosion', true);

// Mage Slayer: daño por segundo y −% de daño de hechizos del objetivo.
passiveItem('mage_slayer', (it) => ({
  onAttackLanded(m, ev) {
    const u = m.owner as Unit;
    debuff(u, ev.target as Unit, it, {
      name: 'mage_slayer', duration: iv(it, 'duration'), fx: 'mage_slayer', interval: 1,
      props: { spellAmp: -iv(it, 'spell_amp_debuff') / 100 },
      onInterval(mm) { damage(u, mm.owner as Unit, iv(it, 'dps'), 'physical', it, { noProc: true }); },
    });
  },
}));

// Revenant's Brooch: probabilidad de añadir un % del ataque como daño mágico.
passiveItem('revenants_brooch', (it) => ({
  onAttackLanded(m, ev) {
    const u = m.owner as Unit;
    if (!real(u) || u.w.rng() >= iv(it, 'crit_chance') / 100) return;
    damage(u, ev.target as Unit, ev.damage * ev.critMult * iv(it, 'crit_multiplier') / 100, 'magical', it, { noProc: true });
  },
}));

/** Splitshot de Specialist's Array y Polycephaly de Hydra's Breath. */
function splitShot(it: ItemInst, onSecondary?: (u: Unit, e: Unit) => void): Partial<ModSpec> {
  return {
    onAttackStart(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (u.melee || !real(u) || ev.fake || u.w.rng() >= iv(it, 'proc_chance') / 100) return;
      ev.damage += iv(it, 'base_proc_dmg');
      const range = u.s.attackRange + iv(it, 'secondary_target_range_bonus') + u.radius;
      const ang = Math.atan2(t.y - u.y, t.x - u.x);
      const half = iv(it, 'secondary_target_angle') / 2 * Math.PI / 180;
      const extra = u.w.enemiesIn(u.team, u.x, u.y, range)
        .filter((e) => e !== t && e.kind !== 'ward' && u.w.canSee(u.team, e) && !e.has(ST.invulnerable))
        .filter((e) => { let d = Math.atan2(e.y - u.y, e.x - u.x) - ang; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) <= half; })
        .sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))
        .slice(0, iv(it, 'count'));
      const amount = iv(it, 'base_proc_dmg') + (ev.damage - iv(it, 'base_proc_dmg')) * iv(it, 'proc_dmg_pct') / 100;
      for (const e of extra) {
        u.w.addProjectile({
          kind: 'track', fx: 'attack:' + (u.hero?.key ?? u.name), source: u, target: e, x: u.x, y: u.y, speed: u.base.projSpeed, dodgeable: true,
          onHit() {
            if (e.has(ST.ethereal)) return true;
            dealDamage({ source: u, target: e, amount, type: 'physical', ability: null, isAttack: true, noProc: true });
            onSecondary?.(u, e);
            return true;
          },
        });
      }
    },
  };
}
passiveItem('specialists_array', (it) => ({
  props: { agi: iv(it, 'agility'), damage: iv(it, 'damage') },
  ...splitShot(it),
}));
/** Miasma: % de la vida máxima como daño mágico por segundo. */
function miasma(it: ItemInst, u: Unit, t: Unit) {
  debuff(u, t, it, {
    name: 'hydras_miasma', duration: iv(it, 'poison_duration'), fx: 'poison', interval: 1,
    onInterval(m) {
      const o = m.owner as Unit;
      damage(u, o, iv(it, 'poison_base_damage') + o.s.maxHp * iv(it, 'poison_damage_per_second') / 100, 'magical', it, { noProc: true });
    },
  });
}
passiveItem('hydras_breath', (it) => ({
  props: { str: iv(it, 'strength'), agi: iv(it, 'agility'), damage: iv(it, 'damage') },
  ...splitShot(it, (u, e) => miasma(it, u, e)),
  onAttackLanded(m, ev) { miasma(it, m.owner as Unit, ev.target as Unit); },
}));

// ---------------- Barreras, curas y cargas de almas ----------------

/** Urn, Spirit Vessel, Essence Distiller: cargas al morir héroes enemigos cerca. */
function soulCharges(it: ItemInst, onOwnerDeath = false): Partial<ModSpec> {
  return {
    onCreated() { if (!it.data.init) { it.data.init = true; it.charges = iv(it, 'soul_initial_charge'); } },
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (!real(u) || victim.kind !== 'hero' || victim.team === u.team) return;
      if (Math.hypot(victim.x - u.x, victim.y - u.y) > iv(it, 'soul_radius')) return;
      it.charges += iv(it, 'soul_additional_charges');
    },
    onDeath(m) { if (onOwnerDeath && real(m.owner as Unit)) it.charges += iv(it, 'soul_additional_charges'); },
  };
}
function soulRelease(it: ItemInst, e: Unit, enemyType: 'magical' | 'pure', extra: (u: Unit, e: Unit) => Partial<ModSpec> = () => ({})) {
  const u = own(it);
  if (e.team === u.team) {
    e.addMod({ name: it.key + '_heal', duration: iv(it, 'duration'), fx: 'soul_release', props: { hpRegen: iv(it, 'soul_heal_amount') } }, u, it);
  } else {
    const ex = extra(u, e);
    debuff(u, e, it, {
      name: it.key + '_damage', duration: iv(it, 'duration'), fx: 'soul_release', interval: 1,
      onInterval(m) { damage(u, m.owner as Unit, iv(it, 'soul_damage_amount'), enemyType, it, { noProc: true }); },
      ...ex,
    });
  }
}
defineItem({
  key: 'urn_of_shadows', target: 'unit', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'nuke' },
  check: needCharges,
  passive: (it) => ({ name: 'p_urn', ...soulCharges(it) }),
  onSpellStart(it, t) { it.charges--; soulRelease(it, (t.unit as Unit) ?? own(it), 'pure'); },
});
defineItem({
  key: 'spirit_vessel', target: 'unit', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'nuke' },
  check: needCharges,
  passive: (it) => ({ name: 'p_vessel', ...soulCharges(it, true) }),
  onSpellStart(it, t) {
    it.charges--;
    soulRelease(it, (t.unit as Unit) ?? own(it), 'magical', (u) => ({
      props: { hpRegenAmp: -iv(it, 'restoration_reduction_enemy') / 100, msSlow: iv(it, 'enemy_slow_pct') / 100 },
      onInterval(m) {
        const o = m.owner as Unit;
        damage(u, o, iv(it, 'soul_damage_amount') + o.hp * iv(it, 'enemy_hp_drain') / 100, 'magical', it, { noProc: true });
      },
    }));
  },
});
/** Essence Distiller en un enemigo: daño, True Sight sobre él y visión compartida. */
function distillOn(it: ItemInst, e: Unit) {
  soulRelease(it, e, 'pure', (u) => ({
    states: ST.revealed, data: { team: u.team },
    onInterval(m) {
      const o = m.owner as Unit;
      damage(u, o, iv(it, 'soul_damage_amount'), 'pure', it, { noProc: true });
    },
    onTick(m) { const o = m.owner as Unit; u.w.addVision(u.team, o.x, o.y, iv(it, 'latch_vision'), 0.1); },
  }));
}
defineItem({
  key: 'essence_distiller', target: 'unitOrPoint', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'nuke' },
  check: needCharges,
  passive: (it) => ({ name: 'p_distiller', ...soulCharges(it) }),
  onSpellStart(it, t) {
    const u = own(it);
    it.charges--;
    if (t.unit) { (t.unit.team === u.team ? soulRelease(it, t.unit as Unit, 'pure') : distillOn(it, t.unit as Unit)); return; }
    // En el suelo: espera y se engancha al primer enemigo que se acerque.
    u.w.addZone({
      fx: 'essence_distiller', x: t.x, y: t.y, r: iv(it, 'latch_range'), team: u.team, interval: 0.1, duration: iv(it, 'ground_duration'),
      onInterval(z) {
        const e = u.w.enemiesIn(u.team, z.x, z.y, z.r).find((x) => x.kind !== 'ward');
        if (!e) return;
        distillOn(it, e);
        z.until = u.w.time;
      },
    });
  },
});

// Holy Locket: cargas con el tiempo y al lanzar enemigos; restaura vida y maná a un aliado.
defineItem({
  key: 'holy_locket', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'buff', selfRadius: 600 },
  check: (it) => (it.charges > 0 ? null : 'Sin cargas'),
  passive: (it) => ({
    name: 'p_holy_locket', interval: 0.5,
    data: { onEnemyCast: () => { it.charges = Math.min(iv(it, 'max_charges'), it.charges + 1); } },
    onInterval() { chargeRegen(it, iv(it, 'max_charges'), iv(it, 'charge_gain_timer')); },
  }),
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    e.addMod({ name: 'holy_locket', duration: iv(it, 'active_buff_duration'), fx: 'heal', props: { healAmp: iv(it, 'incoming_heal_increase_active') / 100 } }, u, it);
    heal(e, it.charges * iv(it, 'health_restore_per_charge'));
    giveMana(e, it.charges * iv(it, 'mana_restore_per_charge'));
    it.charges = 0;
    it.cd = iv(it, 'use_cooldown');
  },
});

// Pavise y Solar Crest: barrera física sobre un aliado.
defineItem({
  key: 'pavise', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(it, t) {
    const e = (t.unit as Unit) ?? own(it);
    e.addMod({ name: 'pavise', duration: iv(it, 'duration'), fx: 'barrier', ...barrier(iv(it, 'absorb_amount'), 'physical') }, own(it), it);
  },
});
defineItem({
  key: 'solar_crest', target: 'unit', team: 'ally', allowSelf: true, castRange: cr, ai: { role: 'buff', selfRadius: 500 },
  passive: (it) => ({ name: 'p_solar_crest', props: { msFlat: iv(it, 'self_movement_speed') } }),
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    e.addMod({ name: 'solar_crest_barrier', duration: iv(it, 'duration'), fx: 'barrier', ...barrier(iv(it, 'absorb_amount'), 'physical') }, u, it);
    // En uno mismo solo da la barrera.
    if (e !== u) {
      e.addMod({ name: 'solar_crest', duration: iv(it, 'duration'), fx: 'solar_crest',
        props: { armor: iv(it, 'target_armor'), attackSpeed: iv(it, 'target_attack_speed'), msPct: iv(it, 'target_movement_speed') / 100 } }, u, it);
    }
  },
});

// Crimson Guard: bloqueo pasivo y, activo, bloqueo garantizado para héroes aliados.
defineItem({
  key: 'crimson_guard', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  passive: (it) => ({ name: 'p_crimson_guard', ...blockSpec(it) }),
  onSpellStart(it) {
    const u = own(it);
    const block = iv(it, 'block_damage_active') + u.s.maxHp * iv(it, 'max_hp_pct') / 100;
    u.w.emit({ n: 'crimson_guard', x: u.x, y: u.y, r: iv(it, 'bonus_aoe_radius'), t: u.team });
    for (const a of u.w.alliesIn(u.team, u.x, u.y, iv(it, 'bonus_aoe_radius'), { heroes: true })) {
      a.addMod({ name: 'crimson_guard', duration: iv(it, 'duration'), fx: 'crimson_guard', props: { damageBlock: block } }, u, it);
    }
  },
});

// Consecrated Wraps: acumula cargas con el tiempo; al recibir daño de un jugador, barrera.
passiveItem('consecrated_wraps', (it) => ({
  interval: 0.1,
  onInterval(m) {
    const u = m.owner as Unit;
    const before = it.charges;
    chargeRegen(it, iv(it, 'abilitycharges'), iv(it, 'abilitychargerestoretime'));
    if (it.charges > before) {
      u.addMod({ name: 'consecrated_haste', duration: iv(it, 'duration'), fx: 'haste',
        props: { msPct: iv(it, 'movement_speed_pct_on_stack_gain') / 100 } }, u, it);
    }
  },
  onTakeDamage(m, ev) {
    const u = m.owner as Unit, s = ev.source as Unit | null;
    if (it.charges <= 0 || !s || s.team === u.team || !playerOwned(s) || ev.amount <= iv(it, 'stack_threshold_damage')) return;
    u.addMod({ name: 'consecrated_barrier', duration: iv(it, 'duration'), fx: 'barrier',
      ...barrier(iv(it, 'barrier_per_stack') * it.charges, 'all') }, u, it);
    it.charges = 0;
    it.data.nextCharge = 0;
  },
}));

// Aeon Disk: al bajar del 70% por daño de jugadores, disipación fuerte y 2,5 s sin daño.
passiveItem('aeon_disk', (it) => ({
  // status_resistance es del buff, no pasivo (sim/items.ts lo suma).
  props: { statusResist: -iv(it, 'status_resistance') / 100 },
  onCreated() { if (!it.data.init) { it.data.init = true; it.cd = iv(it, 'initial_cooldown'); } },
  onIncomingDamage(m, ev) {
    const u = m.owner as Unit;
    if (it.cd > 0 || !real(u) || ev.amount <= 0 || !playerOwned(ev.source as Unit | null)) return;
    if ((ev.source as Unit).team === u.team) return;
    if (u.hp - ev.amount > u.s.maxHp * iv(it, 'health_threshold_pct') / 100) return;
    ev.amount = 0;
    const uses = it.data.uses ?? 0;
    it.cd = lv(it.def.values.cooldown_duration, uses + 1);
    it.data.uses = Math.min(iv(it, 'max_level'), uses + 1);
    u.purge(true, false, true);
    u.w.emit({ n: 'aeon_disk', x: u.x, y: u.y, u: u.id });
    u.addMod({
      name: 'combo_breaker', duration: iv(it, 'buff_duration'), fx: 'aeon_disk', purgable: false,
      props: { statusResist: iv(it, 'status_resistance') / 100, outgoingPct: -1 },
      onIncomingDamage(_m, e2) { e2.amount = 0; },
    }, u, it);
  },
}));

// Bloodstone: aura de vulnerabilidad a hechizos; activa más robo de vida con hechizos.
defineItem({
  key: 'bloodstone', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  passive: (it) => ({
    name: 'p_bloodstone',
    aura: auraSpec(it, 'bloodstone_aura', iv(it, 'aura_radius'), 'enemy', {}, {
      onIncomingDamage(_m, ev) { if (isSpellDamage(ev)) ev.amount *= 1 + iv(it, 'aura_spell_vulnerability') / 100; },
    }),
  }),
  onSpellStart(it) {
    const u = own(it);
    u.addMod({ name: 'bloodpact', duration: iv(it, 'buff_duration'), fx: 'bloodstone',
      props: { spellLifesteal: (iv(it, 'spell_lifesteal_while_active') - iv(it, 'spell_lifesteal')) / 100 } }, u, it);
  },
});

// Veil of Discord: los héroes enemigos del área reciben más daño de hechizos.
defineItem({
  key: 'veil_of_discord', target: 'none', ai: { role: 'aoe', selfRadius: 800 },
  onSpellStart(it) {
    const u = own(it), r = iv(it, 'debuff_radius');
    u.w.emit({ n: 'veil', x: u.x, y: u.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) {
      debuff(u, e, it, { name: 'veil_of_discord', duration: iv(it, 'resist_debuff_duration'), fx: 'veil',
        onIncomingDamage(_m, ev) { if (isSpellDamage(ev)) ev.amount *= 1 + iv(it, 'spell_amp') / 100; } });
    }
  },
});

// Crella's Crozier: aura que reduce la curación enemiga y la redirige; activa: forma etérea y roba velocidad.
defineItem({
  key: 'crellas_crozier', target: 'none', ai: { role: 'escape', selfRadius: 500 },
  passive: (it) => {
    const pct = (u: Unit) => (u.findMod('rite_of_rumusque') ? iv(it, 'active_health_steal') : iv(it, 'health_steal')) / 100;
    return {
      name: 'p_crellas_crozier', interval: iv(it, 'interval'),
      aura: { radius: iv(it, 'radius'), team: 'enemy', heroesOnly: true,
        apply: (m) => { const o = m.owner as Unit; return { name: 'putrefaction', debuff: true, props: () => ({ hpRegenAmp: -pct(o) }) }; } },
      onInterval(m) {
        const u = m.owner as Unit;
        if (!real(u)) return;
        const p = Math.min(0.95, pct(u));
        let lost = 0;
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'radius'), { heroes: true })) {
          if (e.findMod('putrefaction')) lost += Math.max(0, e.s.hpRegen) * p / (1 - p);
        }
        if (lost > 0) heal(u, lost * iv(it, 'interval'), null, true);
      },
    };
  },
  onSpellStart(it) {
    const u = own(it);
    u.addMod({
      ...etherealMod(it, iv(it, 'duration'), false, 'extra_spell_damage_percent'),
      name: 'rite_of_rumusque', interval: 1,
      onInterval() {
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, iv(it, 'active_radius'), { heroes: true })) {
          if (!canDebuff(u, e, it)) continue;
          const pct = iv(it, 'movespeed_steal_pct') / 100;
          e.addMod({ name: 'crozier_steal', duration: iv(it, 'stack_duration'), debuff: true, fx: 'slow', props: { msSlow: pct }, data: { multi: true } }, u, it);
          u.addMod({ name: 'crozier_gain', duration: iv(it, 'stack_duration'), fx: 'haste', props: { msPct: pct }, data: { multi: true } }, u, it);
        }
      },
    }, u, it);
  },
});

// ---------------- Activas de control ----------------

// Gleipnir: raíces en un área.
defineItem({
  key: 'gungir', target: 'unitOrPoint', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'disable' },
  passive: (it) => ({ name: 'p_gungir', props: { hp: iv(it, 'bonus_hp') } }),
  onSpellStart(it, t) {
    const u = own(it);
    const x = t.unit ? t.unit.x : t.x, y = t.unit ? t.unit.y : t.y;
    const r = iv(it, 'radius');
    u.w.emit({ n: 'gungir', x, y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, x, y, r)) root(u, e, iv(it, 'duration'), it, 'eternal_chains');
  },
});

// Nullifier: disipa y mantiene disipado y ralentizado al objetivo.
defineItem({
  key: 'nullifier', target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'nullifier', source: u, target: e, x: u.x, y: u.y, speed: iv(it, 'projectile_speed'), dodgeable: true,
      onHit() {
        if (!canDebuff(u, e, it)) return true;
        e.purge(false, true);
        debuff(u, e, it, {
          name: 'nullify', duration: iv(it, 'mute_duration'), purgable: false, fx: 'nullifier', interval: 0.1,
          props: { msSlow: iv(it, 'slow_pct') / 100 },
          onInterval(m) { (m.owner as Unit).purge(false, true); },
        });
        return true;
      },
    });
  },
});

// Disperser: disipa a ambos; enemigo ralentizado, aliado (y el lanzador) acelerado, decayendo.
function suppressAlly(it: ItemInst, a: Unit) {
  a.purge(true, false);
  a.addMod({
    name: 'disperser_ally', duration: iv(it, 'ally_effect_duration'), fx: 'haste', states: ST.noCollision,
    props: (m) => ({ msPct: iv(it, 'phase_movement_speed') / 100 * Math.max(0, m.remaining / (m.duration || 1)), slowResist: iv(it, 'slow_resist') / 100 }),
    ...refreshEvery(),
  }, own(it), it);
}
passiveItem('disperser', manaBreak, {
  target: 'unit', team: 'any', allowSelf: true, castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    suppressAlly(it, u);
    if (e === u) return;
    if (e.team === u.team) { suppressAlly(it, e); return; }
    if (!canDebuff(u, e, it)) return;
    e.purge(false, true);
    decayingSlow(u, e, it, 'disperser_slow', iv(it, 'enemy_effect_duration'), 1);
  },
});

// Heaven's Halberd: desarma.
defineItem({
  key: 'heavens_halberd', target: 'unit', castRange: cr, reflectable: true, ai: { role: 'disable' },
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    debuff(u, e, it, { name: 'heavens_halberd', duration: e.melee ? iv(it, 'disarm_melee') : iv(it, 'disarm_range'), fx: 'disarm', states: ST.disarmed });
  },
});

// Meteor Hammer: canaliza, cae el meteoro tras un momento, aturde y quema.
defineItem({
  key: 'meteor_hammer', target: 'unitOrPoint', team: 'any', allowSelf: true, castRange: cr, channel: (it) => iv(it, 'abilitychanneltime'),
  ai: { role: 'nuke' },
  onSpellStart(it, t) {
    const u = own(it);
    it.data.x = t.unit ? t.unit.x : t.x; it.data.y = t.unit ? t.unit.y : t.y;
    u.w.emit({ n: 'meteor_hammer_channel', x: it.data.x, y: it.data.y, r: iv(it, 'impact_radius'), d: iv(it, 'abilitychanneltime'), t: u.team });
  },
  onChannelEnd(it, interrupted) {
    if (interrupted) return;
    const u = own(it), x = it.data.x, y = it.data.y, r = iv(it, 'impact_radius');
    u.w.after(iv(it, 'land_time'), () => {
      u.w.emit({ n: 'meteor_hammer', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        if (!canDebuff(u, e, it)) continue;
        stun(u, e, iv(it, 'stun_duration'), it);
        damage(u, e, iv(it, 'impact_damage_units'), 'magical', it);
        debuff(u, e, it, {
          name: 'meteor_burn', duration: iv(it, 'burn_duration'), fx: 'burn', interval: iv(it, 'burn_interval'),
          props: { msSlow: iv(it, 'burn_slow') / 100 },
          onInterval(m) { damage(u, m.owner as Unit, iv(it, 'burn_dps_units') * iv(it, 'burn_interval'), 'magical', it, { noProc: true }); },
        });
      }
    });
  },
});

// Hurricane Pike: en un enemigo os separa y da ataques sin límite de alcance; en aliados, empuja.
defineItem({
  key: 'hurricane_pike', target: 'unit', team: 'any', allowSelf: true, castRange: cr, ai: { role: 'escape' },
  // bonus_attack_speed es de la activa (sim/items.ts lo suma como pasivo).
  passive: (it) => ({ name: 'p_hurricane_pike', props: { attackSpeed: -iv(it, 'bonus_attack_speed') } }),
  onSpellStart(it, t) {
    const u = own(it), e = (t.unit as Unit) ?? u;
    if (e.team === u.team) {
      e.w.disjoint(e);
      push(e, Math.cos(e.facing), Math.sin(e.facing), iv(it, 'push_length'), iv(it, 'push_time'), u, it, 'force_staff');
      return;
    }
    if (!canDebuff(u, e, it)) return;
    const [dx, dy] = dirTo(u, e);
    push(e, dx, dy, iv(it, 'enemy_length'), iv(it, 'push_time'), u, it, 'hurricane_push');
    push(u, -dx, -dy, iv(it, 'enemy_length'), iv(it, 'push_time'), u, it, 'hurricane_push');
    const tid = e.id;
    const onTarget = () => u.atk.target === tid || (u.order?.type === 'attack' && u.order.target === tid);
    u.addMod({
      name: 'hurricane_pike_range', duration: iv(it, 'range_duration'), fx: 'hurricane_pike',
      data: { left: iv(it, 'max_attacks') },
      props: () => (onTarget() ? { attackSpeed: iv(it, 'bonus_attack_speed'), attackRange: 99999 } : {}),
      ...refreshEvery(0.1),
      onAttackStart(m, ev) { if ((ev.target as Unit).id === tid && --m.data.left <= 0) m.remaining = 0.001; },
    }, u, it);
  },
});

// Harpoon: tira de ambos uno hacia otro; Echo Strike como Echo Sabre.
defineItem({
  key: 'harpoon', target: 'unit', castRange: cr, ai: { role: 'disable' },
  passive: (it) => ({
    name: 'p_harpoon',
    ...echoStrike(it, () => own(it).w.time >= (it.data.echoReady ?? 0), () => { it.data.echoReady = own(it).w.time + iv(it, 'passive_cooldown'); }),
  }),
  onSpellStart(it, t) {
    const u = own(it), e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'harpoon', source: u, target: e, x: u.x, y: u.y, speed: iv(it, 'projectile_speed'), dodgeable: true,
      onHit() {
        const d = Math.hypot(e.x - u.x, e.y - u.y) - u.radius - e.radius;
        const total = u.melee ? Math.max(0, d - iv(it, 'min_distance')) : Math.max(0, d) * iv(it, 'pull_distance_pct') / 100;
        if (total <= 0) return true;
        const [dx, dy] = dirTo(u, e);
        const theirs = canDebuff(u, e, it) ? total / 2 : 0;
        push(u, dx, dy, total - theirs, iv(it, 'pull_duration'), u, it, 'harpoon_pull');
        if (theirs > 0) push(e, -dx, -dy, theirs, iv(it, 'pull_duration'), u, it, 'harpoon_pull');
        return true;
      },
    });
  },
});

// ---------------- Auras y activas de equipo ----------------

/** Ancient Janggo y Boots of Bearing: aura de velocidad y activa Endurance. */
function drumItem(key: string, slowImmune: boolean) {
  defineItem({
    key, target: 'none', ai: { role: 'buff', selfRadius: 800 },
    passive: (it) => ({
      name: 'p_' + key,
      props: { str: iv(it, 'bonus_str'), int: iv(it, 'bonus_int') },
      aura: auraSpec(it, 'swiftness_aura', iv(it, 'radius'), 'ally', { msFlat: iv(it, 'aura_movement_speed'), hpRegen: iv(it, 'aura_health_regen') }),
    }),
    onSpellStart(it) {
      const u = own(it), r = iv(it, 'radius');
      u.w.emit({ n: 'endurance', x: u.x, y: u.y, r, t: u.team });
      for (const a of u.w.alliesIn(u.team, u.x, u.y, r)) {
        if (a.kind === 'ward') continue;
        a.addMod({ name: 'endurance', duration: iv(it, 'duration'), fx: 'haste',
          props: { attackSpeed: iv(it, 'bonus_attack_speed_pct'), msPct: iv(it, 'bonus_movement_speed_pct') / 100 } }, u, it);
        if (slowImmune) a.addMod({ name: 'endurance_unslowable', duration: iv(it, 'bonus_ms_duration'), props: { slowResist: 1 } }, u, it);
      }
    },
  });
}
drumItem('ancient_janggo', false);
drumItem('boots_of_bearing', true);

// ---------------- Dominar creeps ----------------

function dominator(key: string, overlord: boolean) {
  defineItem({
    key, target: 'unit', castRange: cr,
    check: (it) => {
      const d = it.data.dominated as Unit | undefined;
      return d && d.alive && own(it).w.time - d.lastHeroDamageAt < iv(it, 'creep_damage_taken_cooldown') ? 'El creep dominado ha recibido daño' : null;
    },
    onSpellStart(it, t) {
      const u = own(it), e = t.unit as Unit;
      if (e.kind !== 'creep' || e.team >= 0 || (!overlord && /ancient/.test(e.name))) {
        refund(it, overlord ? 'Solo creeps neutrales' : 'Solo creeps neutrales no ancestrales'); return;
      }
      // Solo uno a la vez: el anterior muere.
      const prev = it.data.dominated as Unit | undefined;
      if (prev && prev.alive && prev !== e) kill(prev, null);
      u.gold += Math.round(e.bountyGold * iv(it, 'bounty_pct') / 100);
      u.addXp(e.bountyXp * iv(it, 'bounty_pct') / 100);
      e.team = u.team; e.owner = u; e.playerId = u.playerId; e.kind = 'summon';
      e.home = null; e.order = null; e.queue = []; e.atk.target = 0; e.atk.phase = 0;
      e.bountyGold = iv(it, 'bounty_gold');
      e.base = { ...e.base, ms: iv(it, 'speed_base') };
      e.purge(true, false);
      const extraHp = Math.max(0, iv(it, 'health_min') - e.s.maxHp);
      e.addMod({
        name: 'dominated', persistent: true, purgable: false, fx: 'dominated',
        props: { damage: iv(it, 'creep_bonus_damage'), hpRegen: iv(it, 'creep_bonus_hp_regen'), manaRegen: iv(it, 'creep_bonus_mp_regen'),
          armor: iv(it, 'creep_bonus_armor'), hp: extraHp },
      }, u, it);
      if (overlord) for (const a of e.abilities) a.level += iv(it, 'creep_ability_level_increase');
      e.hp = e.s.maxHp;
      it.data.dominated = e;
      u.w.emit({ n: 'dominate', x: e.x, y: e.y, u: e.id, u2: u.id });
    },
  });
}
dominator('helm_of_the_dominator', false);
dominator('helm_of_the_overlord', true);

// ---------------- Rapiers y otros ----------------

// Divine Rapier: alterna entre daño (por defecto) y amplificación de hechizos.
defineItem({
  key: 'rapier', target: 'toggle',
  // sim/items.ts suma los dos stats: se resta el del modo inactivo.
  passive: (it) => ({ name: 'p_rapier', props: () => (it.toggled ? { damage: -iv(it, 'bonus_damage') } : { spellAmp: -iv(it, 'bonus_spell_amp') / 100 }) }),
  onToggle(it) { it.cd = it.def.cd; own(it).refreshStats(); },
});
// Caster Rapier: sin descripción en el dataset; solo stats (spell amp).
statsItem('caster_rapier');
// Chasm Stone: aoe_bonus (radio de habilidades) no existe en el motor.
statsItem('chasm_stone');
