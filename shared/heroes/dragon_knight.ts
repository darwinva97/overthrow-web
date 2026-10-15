import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, dot, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);
const inDragon = (u: Unit) => !!u.findMod('elder_dragon_form');
/** AoE extra de Wyrm's Wrath. */
const wyrmAoe = (u: Unit) => { const w = ability(u, 'dragon_knight_wyrms_wrath'); return w ? val(w, 'bonus_aoe') : 0; };
/** Nivel efectivo de Elder Dragon Form (Scepter suma uno: Black Dragon). */
const formLevel = (a: AbilityInst) => Math.min(4, a.level + (hasScepter(a.owner as Unit) ? val(a, 'scepter_bonus_levels') : 0));
const at = (a: AbilityInst, key: string, level: number) => val({ ...a, level } as AbilityInst, key);
/** Alcance extra de habilidades en forma de dragón. */
const dragonCast = (u: Unit) => { const e = ability(u, 'dragon_knight_elder_dragon_form'); return e && inDragon(u) ? val(e, 'bonus_ability_cast_range') : 0; };

defineAbility({
  key: 'dragon_knight_breathe_fire', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const extra = wyrmAoe(u);
    const bonus = inDragon(u) ? 1 + val(a, 'dragon_form_bonus_pct') / 100 : 1;
    u.w.addProjectile({
      kind: 'linear', fx: 'breathe_fire', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'),
      left: val(a, 'range') + dragonCast(u), width: (val(a, 'start_radius') + extra) * 2, widthEnd: (val(a, 'end_radius') + extra) * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.has(ST.magicImmune)) return;
        damage(u, v, dmg(a, 'damage') * bonus, 'magical', a);
        debuff(u, v, a, {
          name: 'breathe_fire', duration: val(a, 'duration'), fx: 'burn',
          onAttackStart(_m, ev) { ev.damage *= 1 - val(a, 'reduction') / 100; },
        });
      },
    });
  },
});

defineAbility({
  key: 'dragon_knight_dragon_tail', target: 'unit', reflectable: true, ai: { role: 'disable' },
  castRange: (a) => val(a, 'abilitycastrange') + dragonCast(a.owner as Unit),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const hit = () => {
      if (e.team !== u.team && e.has(ST.magicImmune)) return;
      const r = val(a, 'aoe') + wyrmAoe(u);
      u.w.emit({ n: 'dragon_tail', x: e.x, y: e.y, r, u: e.id });
      const list = u.w.enemiesIn(u.team, e.x, e.y, r);
      if (!list.includes(e)) list.push(e);
      for (const v of list) {
        damage(u, v, dmg(a, 'damage') + v.s.maxHp * val(a, 'damage_pct') / 100, 'magical', a);
        stun(u, v, dur(a, 'stun_duration'), a);
      }
    };
    // En forma de dragón es un proyectil.
    if (!inDragon(u)) { hit(); return; }
    u.w.addProjectile({
      kind: 'track', fx: 'dragon_tail', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() { hit(); return true; },
    });
  },
});

defineAbility({
  key: 'dragon_knight_wyrms_wrath', target: 'passive',
  passive: (a) => ({
    name: 'wyrms_wrath',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      const u = ev.attacker as Unit;
      if (ev.fake || t.team === u.team || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      damage(u, t, val(a, 'magic_damage') * a.upg.dmg, 'magical', a, { noProc: true });
    },
  }),
});

defineAbility({
  key: 'dragon_knight_fireball', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius') + wyrmAoe(a.owner as Unit),
  // Menos alcance en cuerpo a cuerpo; en forma de dragón, más.
  castRange: (a) => (inDragon(a.owner as Unit) ? val(a, 'abilitycastrange') + dragonCast(a.owner as Unit) : val(a, 'abilitycastrange') * 0.75),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius') + wyrmAoe(u);
    const every = val(a, 'burn_interval');
    u.w.emit({ n: 'fireball', x: t.x, y: t.y, r, d: val(a, 'duration'), t: u.team });
    u.w.addZone({
      fx: 'fireball', x: t.x, y: t.y, r, team: u.team, interval: every, duration: dur(a, 'duration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
          // El fuego se queda en el enemigo un rato al salir.
          dot(u, e, a, 'fireball_burn', val(a, 'linger_duration'), dmg(a, 'damage'), 'magical', every, { fx: 'burn' });
        }
      },
    });
  },
});

defineAbility({
  key: 'dragon_knight_dragon_blood', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'dragon_blood',
    props: (m) => {
      const k = inDragon(m.owner as Unit) ? 1 + val(a, 'regen_and_armor_multiplier_during_dragon_form') / 100 : 1;
      return { hpRegen: val(a, 'health_regen') * k, armor: val(a, 'armor') * k };
    },
  }),
});

defineAbility({
  key: 'dragon_knight_elder_dragon_form', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const L = formLevel(a);
    u.removeModsByName('elder_dragon_form');
    u.w.emit({ n: 'elder_dragon_form', x: u.x, y: u.y, u: u.id, v: L });
    u.addMod({
      name: 'elder_dragon_form', duration: dur(a, 'duration'), fx: 'dragon_form_' + L,
      states: at(a, 'flying_movement', L) > 0 ? ST.flying | ST.noCollision : 0,
      props: { msFlat: at(a, 'bonus_movement_speed', L), magicResist: at(a, 'magic_resistance', L) / 100, damage: at(a, 'bonus_attack_damage', L) },
      onCreated(m) {
        // Ataque a distancia: se cambia la base mientras dura.
        const b = u.base;
        m.data.orig = { melee: b.melee, range: b.range, projSpeed: b.projSpeed };
        u.base = { ...b, melee: false, range: b.range + val(a, 'bonus_attack_range'), projSpeed: 1400 };
      },
      onDestroy(m) {
        const o = m.data.orig;
        if (o) u.base = { ...u.base, melee: o.melee, range: o.range, projSpeed: o.projSpeed };
        u.refreshStats();
      },
      onAttackLanded(_m, ev) {
        const t = ev.target as Unit;
        if (t.team === u.team || ev.fake && ev.attacker !== u) return;
        const hit = [t];
        // Rojo: daño de salpicadura.
        const sp = at(a, 'ranged_splash_damage_pct', L);
        if (sp > 0) {
          const r = at(a, 'ranged_splash_radius', L) + wyrmAoe(u);
          for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
            if (e === t) continue;
            hit.push(e);
            damage(u, e, ev.damage * sp / 100, 'physical', a, { noProc: true });
          }
        }
        for (const e of hit) {
          // Verde: corrosión (también a estructuras).
          dot(u, e, a, 'corrosive_breath', at(a, 'corrosive_duration', L), at(a, 'corrosive_damage_per_second', L), 'magical', 1, { fx: 'poison' });
          // Azul: escarcha que atraviesa la inmunidad a debuffs.
          const fd = at(a, 'frost_duration', L);
          if (fd > 0) {
            e.addMod({
              name: 'frost_breath', duration: fd, debuff: true, fx: 'frost',
              props: { msSlow: at(a, 'frost_bonus_movement_speed', L) / 100, attackSlow: at(a, 'frost_bonus_attack_speed', L) },
            }, u, a);
          }
        }
      },
    }, u, a);
    u.refreshStats();
  },
});

defineHero('dragon_knight', ['dragon_knight_breathe_fire', 'dragon_knight_dragon_tail', 'dragon_knight_wyrms_wrath', 'dragon_knight_fireball', 'dragon_knight_dragon_blood', 'dragon_knight_elder_dragon_form'], {
  build: ['bracer', 'power_treads', 'blink', 'black_king_bar', 'assault', 'heart', 'satanic', 'ultimate_scepter'],
  upgrades: [
    { slot: 0, key: 'damage', amount: 40, max: 5, label: 'Breathe Fire: +40 daño' },
    { slot: 1, key: 'stun_duration', amount: 0.2, max: 4, label: 'Dragon Tail: +0,2 s de aturdimiento' },
    { slot: 2, key: 'magic_damage', amount: 8, max: 5, label: "Wyrm's Wrath: +8 daño mágico" },
    { slot: 5, key: 'bonus_attack_range', amount: 50, max: 4, label: 'Elder Dragon Form: +50 alcance' },
    { slot: 5, key: 'duration', amount: 8, max: 4, label: 'Elder Dragon Form: +8 s' },
  ],
});
