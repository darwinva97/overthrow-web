import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { burnMana, creditHero, damage, giveMana, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { cleave } from './lib/a0';
import { castDir, debuff, hex, stun } from './util';

/** Duración de los debuffs de Lion con To Hell and Back (+% tras una kill o asistencia). */
function ld(u: Unit, d: number) {
  const m = u.findMod('thab_debuff_amp', u);
  return m ? d * (1 + m.data.amp) : d;
}

defineAbility({
  key: 'lion_impale', target: 'unitOrPoint', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = val(a, 'abilitycastrange') + u.s.castRange + val(a, 'length_buffer');
    const w = val(a, 'width');
    // Talento: cono de 30 grados.
    const wEnd = val(a, 'cone_shaped') > 0 ? w + 2 * len * Math.tan(15 * Math.PI / 180) : w;
    u.w.addProjectile({
      kind: 'linear', fx: 'impale', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'speed'), left: len, width: w, widthEnd: wEnd,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || v.kind === 'fountain') return;
        if (v.has(ST.magicImmune) && val(a, 'pierces_immunity') <= 0) return;
        // Lanzado por los aires: aturdido ya, el daño llega al caer.
        stun(u, v, ld(u, dur(a, 'duration')), a);
        u.w.emit({ n: 'stun', x: v.x, y: v.y, u: v.id });
        u.w.after(0.5, () => { if (v.alive) damage(u, v, dmg(a, 'damage'), 'magical', a); });
      },
    });
  },
});

defineAbility({
  key: 'lion_voodoo', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const r = val(a, 'radius');
    const targets = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r) : [e];
    if (!targets.includes(e)) targets.push(e);
    for (const v of targets) {
      // El hex destruye las ilusiones.
      if (v.kind === 'illusion') { kill(v, u); continue; }
      hex(u, v, ld(u, dur(a, 'duration')), a, val(a, 'movespeed'));
    }
  },
});

defineAbility({
  key: 'lion_mana_drain', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const list = [e];
    // Shard: hasta 2 enemigos más.
    if (hasShard(u) && e.team !== u.team) {
      const extra = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'), { heroes: true })
        .filter((x) => x !== e).slice(0, val(a, 'shard_bonus_targets'));
      list.push(...extra);
    }
    a.data.targets = [];
    for (const v of list) {
      if (v.team !== u.team && v.kind === 'illusion') { kill(v, u); continue; }
      a.data.targets.push(v.id);
    }
    a.data.acc = 0;
    if (hasShard(u)) {
      u.addMod({
        name: 'mana_drain_shield', duration: val(a, 'abilitychanneltime'), fx: 'bkb',
        states: ST.magicImmune, props: { magicResist: val(a, 'magic_resist') / 100 },
      }, u, a);
    }
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const tick = val(a, 'tick_interval');
    a.data.acc += dt;
    const alive = (a.data.targets as number[]).map((id) => u.w.units.get(id)).filter((v): v is Unit =>
      !!v && v.alive && u.w.targetable(v) && Math.hypot(v.x - u.x, v.y - u.y) <= val(a, 'break_distance') &&
      (v.team === u.team || !v.has(ST.magicImmune)));
    if (!alive.length) { u.w.interruptCast(u, false); return; }
    a.data.targets = alive.map((v) => v.id);
    while (a.data.acc >= tick) {
      a.data.acc -= tick;
      const per = val(a, 'mana_per_second') * tick;
      for (const v of alive) {
        if (v.team === u.team) {
          // Aliado: le da maná y velocidad a la mitad de ritmo.
          const k = val(a, 'ally_pct') / 100;
          const give = Math.min(u.mana, per * k);
          u.mana -= give; giveMana(v, give);
          v.addMod({ name: 'mana_drain_haste', duration: 0.3, fx: 'haste', props: { msPct: val(a, 'movespeed') * k / 100 } }, u, a);
          continue;
        }
        const got = burnMana(v, per);
        giveMana(u, got);
        if (val(a, 'damage_pct') > 0) damage(u, v, got * val(a, 'damage_pct') / 100, 'magical', a, { noProc: true });
        const slowPct = val(a, 'movespeed') + (v.mana <= 0 ? val(a, 'movespeed_bonus_when_empty_pct') : 0);
        debuff(u, v, a, { name: 'mana_drain', duration: 0.3, fx: 'slow', props: { msSlow: slowPct / 100 } });
      }
    }
  },
  onChannelEnd(a) {
    (a.owner as Unit).removeModsByName('mana_drain_shield');
  },
});

// Innata: amplificación de hechizos al reaparecer y de duración de debuffs tras cada kill o asistencia.
defineAbility({
  key: 'lion_to_hell_and_back', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'to_hell_and_back',
    onRespawn(m) {
      const u = m.owner as Unit;
      u.addMod({ name: 'thab_spell_amp', duration: val(a, 'duration'), fx: 'fiery_soul', props: { spellAmp: val(a, 'spell_amp') / 100 } }, u, a);
    },
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const at = victim.damagedBy.get(u.id);
      const mine = creditHero(killer as Unit) === u || (at !== undefined && u.w.time - at <= 15);
      if (!mine) return;
      u.removeModsByName('thab_spell_amp');
      // Dura mientras la víctima siga muerta.
      u.addMod({
        name: 'thab_debuff_amp', fx: 'fiery_soul', data: { amp: val(a, 'debuff_amp') / 100, victim: victim.id },
        onTick(mm) {
          const v = u.w.units.get(mm.data.victim);
          if (!v || v.alive) mm.remaining = 0.001;
        },
      }, u, a);
    },
  }),
});

defineAbility({
  key: 'lion_finger_of_death', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.55 },
  aoe: (a) => val(a, 'splash_radius'),
  passive: (a) => ({ name: 'finger_kills', stacks: a.data.kills ?? 0 }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const bonus = (a.data.kills ?? 0) * val(a, 'damage_per_kill');
    const amount = dmg(a, 'damage') + bonus;
    // Scepter: también daña alrededor del objetivo.
    const r = val(a, 'splash_radius');
    const targets = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r) : [e];
    if (!targets.includes(e)) targets.push(e);
    u.w.emit({ n: 'laguna', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id, c: 'lion' });
    u.w.after(val(a, 'damage_delay'), () => {
      for (const v of targets) {
        if (!v.alive || (v.has(ST.magicImmune) && v !== e)) continue;
        damage(u, v, amount, 'magical', a);
        if (v.kind === 'hero') watchKill(a, v);
      }
    });
    if (!a.temp) empowerFist(a);
  },
});

/** Si el héroe muere en el periodo de gracia, Finger of Death gana daño permanente. */
function watchKill(a: AbilityInst, v: Unit) {
  const u = a.owner as Unit;
  const check = () => {
    if (v.alive || a.data.counted?.[v.id] === v.deaths) return;
    a.data.counted ??= {};
    a.data.counted[v.id] = v.deaths;
    a.data.kills = (a.data.kills ?? 0) + 1;
    if (a.passiveMod) a.passiveMod.stacks = a.data.kills;
  };
  if (!v.alive) check();
  else u.w.after(val(a, 'grace_period'), check);
}

/** Tras Finger of Death, Lion pega cuerpo a cuerpo con barrido y más velocidad. */
function empowerFist(a: AbilityInst) {
  const u = a.owner as Unit;
  u.removeModsByName('finger_fist');
  u.addMod({
    name: 'finger_fist', duration: val(a, 'punch_duration'), fx: 'berserk',
    data: { melee: u.base.melee, range: u.base.range },
    props: () => ({
      msPct: val(a, 'punch_bonus_movespeed') / 100,
      damage: val(a, 'punch_bonus_damage_base') + (a.data.kills ?? 0) * val(a, 'damage_per_kill'),
    }),
    onCreated() { u.base.melee = true; u.base.range = val(a, 'punch_attack_range'); },
    onDestroy(m) { u.base.melee = m.data.melee; u.base.range = m.data.range; u.refreshStats(); },
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (t.team === u.team) return;
      cleave(u, t, ev.damage * ev.critMult * val(a, 'cleave_damage') / 100,
        val(a, 'cleave_starting_width'), val(a, 'cleave_ending_width'), val(a, 'cleave_distance'), a);
      if (t.kind === 'hero') watchKill(a, t);
    },
  }, u, a);
}

defineHero('lion', ['lion_impale', 'lion_voodoo', 'lion_mana_drain', 'lion_to_hell_and_back', 'lion_finger_of_death'], {
  build: ['null_talisman', 'tranquil_boots', 'blink', 'aether_lens', 'force_staff', 'black_king_bar', 'ultimate_scepter', 'octarine_core'],
});
