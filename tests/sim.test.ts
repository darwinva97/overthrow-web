// Fórmulas de Dota y mecánicas clave, sin red ni render.
import { describe, expect, it } from 'vitest';
import '../shared/heroes';
import '../shared/items';
import { HEROES } from '../shared/data';
import { addHero, createGame } from '../shared/game/setup';
import { levelAbility, val } from '../shared/sim/abilities';
import { buyItem, syncItemPassives } from '../shared/sim/items';
import { ST } from '../shared/sim/types';
import { armorMult } from '../shared/sim/unit';

function duel(a: string, b: string) {
  const g = createGame('necropolis', 7);
  const u = addHero(g, a, 0, 'p1');
  const v = addHero(g, b, 1, 'p2');
  // Los dos en mitad del mapa, lejos de fuentes.
  g.world.teleport(u, -150, 420);
  g.world.teleport(v, 150, 420);
  g.world.computeVision();
  return { g, w: g.world, u, v };
}
/** Hueco de una habilidad por su clave (el orden de los kits sigue a Valve). */
const slotOf = (u: { abilities: { key: string }[] }, key: string) => u.abilities.findIndex((a) => a.key === key);
const run = (w: { tick(): void }, seconds: number) => { for (let i = 0; i < seconds * 30; i++) w.tick(); };

describe('fórmulas', () => {
  it('vida de Pudge a nivel 1: 120 + 22 por fuerza', () => {
    const { u } = duel('pudge', 'lina');
    expect(u.s.maxHp).toBe(120 + HEROES.pudge.str * 22);
  });
  it('1 de armadura reduce un ~5,7% y 10 un 37,5%', () => {
    expect(1 - armorMult(1)).toBeCloseTo(0.0566, 3);
    expect(1 - armorMult(10)).toBeCloseTo(0.375, 3);
  });
  it('los items de stats suman sus valores del dataset', () => {
    const { u } = duel('juggernaut', 'lina');
    const before = u.s.agi;
    u.gold = 10000;
    u.x = u.w.teams[0].fountain.x; u.y = u.w.teams[0].fountain.y;
    expect(buyItem(u, 'blade_of_alacrity')).toBeNull();
    expect(u.s.agi - before).toBe(10);
  });
  it('comprar un item con receta consume los componentes', () => {
    const { u } = duel('axe', 'lina');
    u.gold = 10000;
    u.x = u.w.teams[0].fountain.x; u.y = u.w.teams[0].fountain.y;
    buyItem(u, 'circlet'); buyItem(u, 'gauntlets');
    const gold = u.gold;
    expect(buyItem(u, 'bracer')).toBeNull();
    expect(u.items.filter(Boolean).map((i) => i!.key)).toEqual(['bracer']);
    expect(gold - u.gold).toBe(505 - 155 - 140);
  });
});

describe('habilidades', () => {
  it('Dragon Slave hace su daño mágico por nivel', () => {
    const { w, u, v } = duel('lina', 'axe');
    levelAbility(u, u.abilities[0]);
    w.fx.length = 0;
    w.issueOrder(v, { type: 'hold' });
    w.issueOrder(u, { type: 'cast', slot: 0, x: v.x, y: v.y });
    run(w, 1.5);
    const dealt = w.fx.filter((f) => f.n === 'num' && f.u === v.id && f.c === 'magical').reduce((s, f) => s + (f.v ?? 0), 0);
    const expected = val(u.abilities[0], 'dragon_slave_damage') * (1 - v.s.mr);
    expect(dealt).toBeCloseTo(expected, -1);
  });
  it('BKB impide el aturdimiento de Light Strike Array', () => {
    const { w, u, v } = duel('lina', 'axe');
    const lsa = slotOf(u, 'lina_light_strike_array');
    u.abilityPoints = 5; levelAbility(u, u.abilities[lsa]);
    v.gold = 10000;
    v.items[0] = null; buyItem(v, 'black_king_bar');
    v.items[0] ??= v.stash.shift()!;
    syncItemPassives(v);
    w.issueOrder(v, { type: 'item', slot: 0 });
    run(w, 0.1);
    expect(v.has(ST.magicImmune)).toBe(true);
    w.issueOrder(u, { type: 'cast', slot: lsa, x: v.x, y: v.y });
    run(w, 1.2);
    expect(v.findMod('stunned')).toBeUndefined();
  });
  it('Spirit Lance crea una ilusión que ataca al objetivo', () => {
    const { w, u, v } = duel('phantom_lancer', 'lina');
    levelAbility(u, u.abilities[0]);
    w.issueOrder(u, { type: 'cast', slot: 0, target: v.id });
    run(w, 1.5);
    const ill = w.list.filter((x) => x.kind === 'illusion' && x.owner === u);
    expect(ill.length).toBe(1);
    expect(ill[0].order).toMatchObject({ type: 'attack', target: v.id });
  });
  it('Culling Blade ejecuta por debajo del umbral', () => {
    const { w, u, v } = duel('axe', 'lina');
    const cb = slotOf(u, 'axe_culling_blade');
    u.level = 6; u.abilityPoints = 1;
    levelAbility(u, u.abilities[cb]);
    w.teleport(v, u.x + 100, u.y);
    v.hp = 200;
    w.issueOrder(u, { type: 'cast', slot: cb, target: v.id });
    run(w, 1);
    expect(v.alive).toBe(false);
    expect(u.kills).toBe(1);
    expect(u.abilities[cb].cd).toBe(0);
  });
  it('Counterspell refleja Laguna Blade a su autora', () => {
    const { w, u, v } = duel('lina', 'antimage');
    const lg = slotOf(u, 'lina_laguna_blade'), cs = slotOf(v, 'antimage_counterspell');
    u.level = 6; u.abilityPoints = 1; levelAbility(u, u.abilities[lg]);
    v.abilityPoints = 1; levelAbility(v, v.abilities[cs]);
    w.issueOrder(v, { type: 'cast', slot: cs });
    w.issueOrder(u, { type: 'cast', slot: lg, target: v.id });
    const linaHp = u.hp, amHp = v.hp;
    run(w, 1);
    expect(v.hp).toBe(Math.min(v.s.maxHp, v.hp));
    expect(amHp - v.hp).toBeLessThan(5);
    expect(linaHp - u.hp).toBeGreaterThan(200);
  });
});

describe('Overthrow', () => {
  it('cada kill suma al equipo y el orbe raro llega a las 8', () => {
    const { g, u, v } = duel('axe', 'lina');
    for (let i = 0; i < 8; i++) {
      v.hp = 1;
      u.w.teleport(v, u.x + 100, u.y);
      // Kill directa para el contador del modo.
      (g.world as any).rules.onHeroKilled(v, u, []);
    }
    expect(g.world.teams[0].kills).toBe(8);
    expect(u.orbPicks.some((p) => p.rarity === 'rare')).toBe(true);
  });
});

describe('talentos y Aghanim', () => {
  it('los enlaces de valores de Valve se aplican con val()', async () => {
    const { applyOp } = await import('../shared/sim/abilities');
    expect(applyOp(70, '-20', 1)).toBe(50);
    expect(applyOp(100, '+50%', 1)).toBe(150);
    expect(applyOp(3, 'x2', 1)).toBe(6);
    expect(applyOp(0, '0.8 1.0 1.2', 2)).toBe(1);
  });
  it('el talento de Lina baja 20 s el enfriamiento de Laguna Blade', async () => {
    const { cooldownOf } = await import('../shared/sim/abilities');
    const { pickTalent } = await import('../shared/sim/talents');
    const { u } = duel('lina', 'axe');
    const laguna = u.abilities.find((a) => a.key === 'lina_laguna_blade')!;
    u.level = 20; u.abilityPoints = 10;
    levelAbility(u, laguna);
    const before = cooldownOf(laguna);
    expect(pickTalent(u, 'special_bonus_unique_lina_6')).toBe(true);
    expect(before - cooldownOf(laguna)).toBeCloseTo(20, 5);
  });
  it('los talentos genéricos dan stats y Shard/Scepter se compran', async () => {
    const { pickTalent } = await import('../shared/sim/talents');
    const { hasScepter, hasShard } = await import('../shared/sim/abilities');
    const { u } = duel('lina', 'axe');
    u.level = 10; u.abilityPoints = 1;
    const dmg = u.s.dmgBonus;
    expect(pickTalent(u, 'special_bonus_attack_damage_25')).toBe(true);
    expect(u.s.dmgBonus - dmg).toBe(25);
    u.gold = 20000;
    expect(buyItem(u, 'aghanims_shard')).toBeNull();
    expect(buyItem(u, 'ultimate_scepter_2')).toBeNull();
    expect(hasShard(u) && hasScepter(u)).toBe(true);
  });
});
