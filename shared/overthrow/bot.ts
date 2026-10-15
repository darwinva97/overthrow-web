// IA de los bots. Piensa cinco veces por segundo y solo da órdenes cuando cambia de idea.
import { HERO_KITS, HERO_OPTS, available, canLevelAbility, castRangeOf, levelAbility } from '../sim/abilities';
import { botTalent } from '../sim/talents';
import { applyNeutralPick } from './neutrals';
import { buyItem, isShopItem, purchaseCost } from '../sim/items';
import type { AbilityInst, ItemInst, Order } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import { applyPick, THRONE_RADIUS, type OverthrowRules } from './rules';

export const BUILDS: Record<string, string[]> = {
  lina: ['null_talisman', 'phase_boots', 'kaya', 'cyclone', 'black_king_bar', 'sheepstick', 'greater_crit'],
  pudge: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'heart', 'shivas_guard', 'refresher'],
  juggernaut: ['wraith_band', 'phase_boots', 'maelstrom', 'black_king_bar', 'butterfly', 'greater_crit', 'abyssal_blade'],
  crystal_maiden: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'black_king_bar', 'sheepstick', 'refresher'],
  sniper: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'mjollnir', 'greater_crit', 'satanic'],
  antimage: ['wraith_band', 'power_treads', 'bfury', 'manta', 'black_king_bar', 'skadi', 'butterfly'],
  phantom_lancer: ['wraith_band', 'power_treads', 'diffusal_blade', 'manta', 'heart', 'skadi', 'butterfly'],
  axe: ['bracer', 'phase_boots', 'blink', 'blade_mail', 'black_king_bar', 'heart', 'assault'],
};

/** Compra genérica por atributo para héroes sin build propia. */
const DEFAULT_BUILD: Record<string, string[]> = {
  str: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'heart', 'assault', 'ultimate_scepter'],
  agi: ['wraith_band', 'power_treads', 'maelstrom', 'black_king_bar', 'butterfly', 'greater_crit', 'satanic'],
  int: ['null_talisman', 'arcane_boots', 'force_staff', 'black_king_bar', 'sheepstick', 'ultimate_scepter', 'refresher'],
  all: ['bracer', 'phase_boots', 'maelstrom', 'black_king_bar', 'ultimate_scepter', 'assault', 'greater_crit'],
};

/** Héroes que un bot puede elegir. */
export const playableHeroes = () => Object.keys(HERO_KITS);

interface BotState { next: number; key: string; retreat: boolean; build: number; target: number }

const pct = (u: Unit) => u.hp / u.s.maxHp;

export function botThink(w: World, h: Unit, rules: OverthrowRules) {
  const ai: BotState = h.ai ??= { next: 0, key: '', retreat: false, build: 0, target: 0 };
  if (w.time < ai.next) return;
  ai.next = w.time + 0.2 + w.rng() * 0.05;

  botTalent(h);
  while (h.neutralPicks.length) applyNeutralPick(h, Math.floor(w.rng() * h.neutralPicks[0].trinkets.length), Math.floor(w.rng() * h.neutralPicks[0].enhancements.length));
  while (h.abilityPoints > 0) {
    const order = [...h.abilities].filter((a) => canLevelAbility(h, a))
      .sort((a, b) => Number(!!b.impl.ult) - Number(!!a.impl.ult) || a.level - b.level || a.slot - b.slot);
    if (!order.length || !levelAbility(h, order[0])) break;
  }
  while (h.orbPicks.length) applyPick(h, Math.floor(w.rng() * h.orbPicks[0].options.length));
  shop(h, ai);
  if (!h.alive) return;

  const fountain = w.teams[h.team].fountain;
  const atHome = Math.hypot(h.x - fountain.x, h.y - fountain.y) < 600;
  if (pct(h) < 0.28) ai.retreat = true;
  if (ai.retreat && (pct(h) > 0.92 || (atHome && pct(h) > 0.85))) ai.retreat = false;

  const enemies = w.list.filter((e) => e.team !== h.team && e.isHeroLike && w.targetable(e) && w.canSee(h.team, e) &&
    Math.hypot(e.x - h.x, e.y - h.y) < 1400);
  const realEnemies = enemies.filter((e) => e.kind === 'hero');

  if (ai.retreat) {
    if (realEnemies.length) useItems(w, h, realEnemies[0], true);
    useEscape(w, h, fountain);
    return order(w, h, ai, { type: 'move', x: fountain.x, y: fountain.y });
  }
  if (pct(h) < 0.6 && !realEnemies.length) useHeal(w, h);

  // Elige objetivo: el enemigo más rematable cerca.
  let target: Unit | null = null, best = Infinity;
  for (const e of enemies) {
    const d = Math.hypot(e.x - h.x, e.y - h.y);
    const score = pct(e) * 900 + d + (e.kind === 'illusion' ? 600 : 0);
    if (score < best) { best = score; target = e; }
  }
  if (target) {
    const strength = pct(h) * h.level;
    const theirs = pct(target) * target.level;
    if (strength >= theirs * 0.7 || pct(target) < 0.3) {
      ai.target = target.id;
      if (castAbilities(w, h, target)) return;
      useItems(w, h, target, false);
      return order(w, h, ai, { type: 'attack', target: target.id });
    }
    if (pct(h) < 0.5) { ai.retreat = true; return; }
  }
  toggleOff(w, h);

  // Sin pelea: orbe en el suelo, trono o campamento.
  const orb = rules.orbs.filter((o) => o.landed).sort((a, b) =>
    Math.hypot(a.unit.x - h.x, a.unit.y - h.y) - Math.hypot(b.unit.x - h.x, b.unit.y - h.y))[0];
  if (orb && Math.hypot(orb.unit.x - h.x, orb.unit.y - h.y) < 2600) {
    const d = Math.hypot(orb.unit.x - h.x, orb.unit.y - h.y);
    if (d > 120) return order(w, h, ai, { type: 'move', x: orb.unit.x + (h.id % 3) * 30, y: orb.unit.y });
    return order(w, h, ai, { type: 'hold' });
  }
  // Solo farmea campamentos que puede ganar: vida del campamento por debajo de la suya.
  const creep = w.list.find((c) => c.kind === 'creep' && c.alive && w.canSee(h.team, c) && Math.hypot(c.x - h.x, c.y - h.y) < 700);
  if (creep && h.level < 12 && pct(h) > 0.6) {
    const camp = w.list.filter((c) => c.kind === 'creep' && c.alive && Math.hypot(c.x - creep.x, c.y - creep.y) < 400);
    const campHp = camp.reduce((s, c) => s + c.hp, 0);
    if (campHp < h.hp * 1.3) return order(w, h, ai, { type: 'attack', target: creep.id });
  }
  if (Math.hypot(h.x, h.y) > THRONE_RADIUS * 0.6) {
    const ang = (h.id * 2.399) % (Math.PI * 2);
    return order(w, h, ai, { type: 'attackMove', x: Math.cos(ang) * 300, y: Math.sin(ang) * 300 });
  }
}

/** Solo reemite la orden si es distinta a la anterior. */
function order(w: World, h: Unit, ai: BotState, o: Order) {
  const key = JSON.stringify(o);
  if (key === ai.key && h.order) return;
  ai.key = key;
  w.issueOrder(h, o);
}

function shop(h: Unit, ai: BotState) {
  const build = (HERO_OPTS[h.name]?.build ?? BUILDS[h.name] ?? DEFAULT_BUILD[h.hero?.attr ?? 'all']).filter(isShopItem);
  const owned = new Set([...h.items, ...h.stash].filter(Boolean).map((i) => i!.key));
  while (ai.build < build.length && owned.has(build[ai.build])) ai.build++;
  const next = build[ai.build];
  if (next) {
    if (h.gold >= purchaseCost(h, next).cost && !buyItem(h, next)) ai.build++;
    return;
  }
  // Build terminada: tomos de vida, por así decirlo, en forma de stats.
  if (!h.shard && h.gold > 1600) { buyItem(h, 'aghanims_shard'); return; }
  if (h.gold > 3000 && h.freeSlot(false) >= 0) buyItem(h, 'ultimate_orb');
}

function ready(w: World, h: Unit, a: AbilityInst | ItemInst) { return !w.castCheck(h, a); }

function castAbilities(w: World, h: Unit, t: Unit): boolean {
  const d = Math.hypot(t.x - h.x, t.y - h.y);
  if (h.cast) return true;
  for (const a of h.abilities) {
    const ai = a.impl.ai;
    if (!ai || a.level <= 0 || !available(a)) continue;
    if (a.impl.target === 'toggle') {
      const want = d < Math.max(320, h.s.attackRange + 150);
      if (want !== a.toggled && ready(w, h, a)) w.issueOrder(h, { type: 'cast', slot: a.slot });
      continue;
    }
    if (!ready(w, h, a)) continue;
    if (ai.hpBelow && pct(t) > ai.hpBelow) continue;
    const range = a.impl.target === 'none' ? 0 : castRangeOf(a);
    if (a.impl.target === 'none') {
      if (ai.role === 'summon' && pct(h) > 0.6) continue;
      const r = ai.selfRadius ?? 600;
      if (d <= r || ai.role === 'buff' && d < 800) { w.issueOrder(h, { type: 'cast', slot: a.slot }); return true; }
      continue;
    }
    if (ai.role === 'escape') {
      if (d > 450 && d < range + 300 && pct(h) > 0.5) {
        w.issueOrder(h, { type: 'cast', slot: a.slot, x: t.x, y: t.y });
        return true;
      }
      continue;
    }
    if (ai.role === 'summon') {
      if (pct(h) < 0.7) { w.issueOrder(h, { type: 'cast', slot: a.slot, x: h.x, y: h.y }); return true; }
      continue;
    }
    if (d > range + 250) continue;
    // Buffs y curas sobre aliados: al aliado más herido cercano (o a uno mismo).
    if ((a.impl.target === 'unit' || a.impl.target === 'unitOrPoint') && a.impl.team === 'ally') {
      const allies = w.alliesIn(h.team, h.x, h.y, castRangeOf(a) + 100, { heroes: true }).filter((x) => x !== h || a.impl.allowSelf !== false);
      const best = allies.sort((x, y) => pct(x) - pct(y))[0] ?? h;
      w.issueOrder(h, { type: 'cast', slot: a.slot, target: best.id });
      return true;
    }
    if (a.impl.target === 'unit' || a.impl.target === 'unitOrPoint') {
      if (t.has(ST.magicImmune) && !a.def.bkbPierce) continue;
      w.issueOrder(h, { type: 'cast', slot: a.slot, target: t.id });
      return true;
    }
    if (a.impl.target === 'point') {
      // Apunta un poco por delante si el objetivo se mueve.
      const lead = t.order?.type === 'move' ? 120 : 0;
      w.issueOrder(h, { type: 'cast', slot: a.slot, x: t.x + Math.cos(t.facing) * lead, y: t.y + Math.sin(t.facing) * lead });
      return true;
    }
  }
  return false;
}

function toggleOff(w: World, h: Unit) {
  for (const a of h.abilities) if (a.impl.target === 'toggle' && a.toggled) w.issueOrder(h, { type: 'cast', slot: a.slot });
  for (let s = 0; s < 6; s++) {
    const it = h.items[s];
    if (it?.key === 'armlet' && it.toggled) w.issueOrder(h, { type: 'item', slot: s });
  }
}

function useItems(w: World, h: Unit, t: Unit, fleeing: boolean) {
  const d = Math.hypot(t.x - h.x, t.y - h.y);
  for (const s of [0, 1, 2, 3, 4, 5, 9]) {
    const it = h.items[s];
    if (!it || !it.impl || !ready(w, h, it)) continue;
    const role = it.impl.ai?.role;
    const k = it.key;
    if (k === 'armlet') { if (!it.toggled && !fleeing && d < 500) w.issueOrder(h, { type: 'item', slot: s }); continue; }
    if (k === 'power_treads') continue;
    switch (role) {
      case 'bkb': if (d < 700 && pct(h) < 0.85) w.issueOrder(h, { type: 'item', slot: s }); break;
      case 'disable': case 'nuke':
        if (!fleeing && d < 800 && !t.has(ST.magicImmune) && t.kind === 'hero') { w.issueOrder(h, { type: 'item', slot: s, target: t.id }); return; }
        if (fleeing && role === 'disable' && d < 600) { w.issueOrder(h, { type: 'item', slot: s, target: t.id }); return; }
        break;
      case 'escape':
        if (k === 'blink') {
          if (!fleeing && d > 500 && d < 1300 && pct(h) > 0.6) { w.issueOrder(h, { type: 'item', slot: s, x: t.x, y: t.y }); return; }
          break;
        }
        if (fleeing) {
          if (it.impl.target === 'unit') w.issueOrder(h, { type: 'item', slot: s, target: h.id });
          else if (it.impl.target === 'none') w.issueOrder(h, { type: 'item', slot: s });
          return;
        }
        if (k === 'manta' && d < 400) w.issueOrder(h, { type: 'item', slot: s });
        break;
      case 'heal': case 'barrier':
        if (pct(h) < 0.5) w.issueOrder(h, { type: 'item', slot: s }); break;
      case 'buff': case 'aoe':
        if (d < (it.impl.ai?.selfRadius ?? 500)) {
          if (it.impl.target === 'unit') w.issueOrder(h, { type: 'item', slot: s, target: h.id });
          else w.issueOrder(h, { type: 'item', slot: s });
        }
        break;
      case 'chase': if (!fleeing && d > 300) w.issueOrder(h, { type: 'item', slot: s }); break;
      case 'mana': if (h.mana < h.s.maxMana * 0.4) w.issueOrder(h, { type: 'item', slot: s }); break;
    }
  }
}

function useEscape(w: World, h: Unit, home: { x: number; y: number }) {
  for (let s = 0; s < 6; s++) {
    const it = h.items[s];
    if (it?.key === 'blink' && ready(w, h, it)) { w.issueOrder(h, { type: 'item', slot: s, x: home.x, y: home.y }); return; }
  }
  for (const a of h.abilities) {
    if (a.impl.ai?.role === 'escape' && a.impl.target === 'point' && a.level > 0 && ready(w, h, a)) {
      w.issueOrder(h, { type: 'cast', slot: a.slot, x: home.x, y: home.y });
      return;
    }
  }
}

function useHeal(w: World, h: Unit) {
  for (let s = 0; s < 6; s++) {
    const it = h.items[s];
    if (it && (it.key === 'flask' || it.key === 'tango') && ready(w, h, it) && !h.findMod(it.key + '_regen')) {
      w.issueOrder(h, { type: 'item', slot: s, target: h.id });
      return;
    }
  }
}
