// Largo: rana bardo. Amphibian Rhapsody cambia la barra a las canciones, que solo funcionan
// si se tocan al ritmo (cada rhythm_interval) y dan acumulaciones de Groovin'.
import { defineAbility, defineHero, dmg, dur, isItem, manaCostOf, val } from '../sim/abilities';
import { damage, giveMana, heal } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, heroOf, hurtAlly, nearestEnemyHero, ready } from './lib/a4';
import { debuff, push, slow, stun } from './util';

const abil = (u: Unit, key: string) => heroOf(u).abilities.find((x) => x.key === key);

/** Encore: los buffs que Largo pone a su equipo duran más. */
function buffDur(u: Unit, d: number) {
  const e = abil(u, 'largo_encore');
  return e && e.level > 0 ? d * (1 + val(e, 'buff_amplification') / 100) : d;
}

// ---------------- Catchy Lick ----------------

defineAbility({
  key: 'largo_catchy_lick', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const enemy = e.team !== u.team;
    const strong = !!val(a, 'strong_dispel');
    // Disipación básica: buffs del enemigo o debuffs del aliado.
    const before = e.mods.length;
    if (enemy) e.purge(false, true, strong); else e.purge(true, false, strong);
    let gained = e.mods.length < before;
    const d = Math.hypot(u.x - e.x, u.y - e.y);
    const pull = Math.min(val(a, enemy ? 'pull_distance' : 'pull_distance_ally'), Math.max(0, d - u.radius - e.radius - 10));
    if (pull > 0) push(e, u.x - e.x, u.y - e.y, pull, val(a, 'pull_duration'), u, a, 'catchy_lick_pull');
    u.w.emit({ n: 'lick', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    if (enemy) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (!e.alive) gained = true;
    }
    if (gained) {
      u.addMod({ name: 'catchy_lick_regen', duration: buffDur(u, dur(a, 'buff_duration')), fx: 'regen',
        props: { hpRegen: val(a, 'dispel_hp_regen') } }, u, a);
    }
  },
});

// ---------------- Frogstomp ----------------

defineAbility({
  key: 'largo_frogstomp', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const x = t.x, y = t.y, r = val(a, 'radius');
    const n = val(a, 'total_ticks'), every = val(a, 'stomp_interval');
    u.w.emit({ n: 'frog_toss', x: u.x, y: u.y, x2: x, y2: y, t: u.team });
    u.w.after(val(a, 'delay'), () => {
      // Ralentizado mientras se esté dentro de la zona.
      u.w.addZone({
        fx: 'frogstomp', x, y, r, team: u.team, interval: 0.2, duration: n * every,
        onInterval() {
          for (const e of u.w.enemiesIn(u.team, x, y, r, { immune: false })) {
            slow(u, e, a, 'frogstomp_slow', 0.3, val(a, 'slow') / 100);
          }
        },
      });
      for (let i = 0; i < n; i++) {
        u.w.after(every * i, () => {
          u.w.emit({ n: 'frogstomp', x, y, r, t: u.team });
          for (const e of u.w.enemiesIn(u.team, x, y, r, { immune: false })) {
            if (e.kind === 'ward') continue;
            damage(u, e, dmg(a, 'damage_per_stomp'), 'magical', a);
            stun(u, e, val(a, 'stun_duration'), a);
          }
        });
      }
    });
  },
});

// ---------------- Croak of Genius ----------------

function croak(u: Unit, tgt: Unit, a: AbilityInst) {
  const lastHp = new Map<number, number>();
  tgt.addMod({
    name: 'croak_of_genius', duration: buffDur(u, dur(a, 'duration')), fx: 'croak', purgable: true,
    props: { manaReduce: val(a, 'mana_cost_reduction') / 100 },
    // Parte del daño que hace "reverbera" en el objetivo durante unos segundos.
    onDealDamage(_m, ev) {
      const v = ev.target as Unit;
      if (ev.data?.croak || ev.hpRemoval || ev.amount <= 0 || v.team === tgt.team || v.kind === 'ward') return;
      const dd = val(a, 'damage_duration');
      let total = ev.amount * val(a, 'damage_portion_pct') / 100;
      const hpPct = val(a, 'damage_hp_pct');
      if (hpPct > 0 && v.w.time - (lastHp.get(v.id) ?? -99) >= 1) {
        lastHp.set(v.id, v.w.time);
        total += v.s.maxHp * hpPct / 100;
      }
      if (total < 1) return;
      debuff(tgt, v, a, {
        name: 'croak_reverb', duration: dd + 0.05, interval: 1, fx: 'croak_reverb', data: { multi: true },
        onInterval(m) { damage(tgt, m.owner as Unit, total / dd, 'magical', a, { noProc: true, data: { croak: true } }); },
      });
    },
    // Gastar maná acorta el buff (salvo a Largo).
    onAbilityExecuted(m, ab) {
      if (tgt === u) return;
      const cost = isItem(ab) ? ab.def.mc : manaCostOf(ab as AbilityInst);
      if (cost > 0) m.remaining -= val(a, 'duration_reduction');
    },
  }, u, a);
}

defineAbility({
  key: 'largo_croak_of_genius', target: 'unit', team: 'ally', allowSelf: true,
  passive: (a) => botBrain(a, (u) => {
    if (!nearestEnemyHero(u, 1000)) return null;
    const allies = u.w.alliesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'), { heroes: true })
      .filter((x) => x.kind === 'hero' && x !== u && !x.findMod('croak_of_genius'));
    if (allies.length) return { target: allies[0] };
    return u.findMod('croak_of_genius') ? null : { target: u };
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const tgt = (t.unit as Unit) ?? u;
    croak(u, tgt, a);
    // Shard (Encore): el buff también se lo queda Largo, o el aliado más cercano si era él.
    const enc = abil(u, 'largo_encore');
    if (!enc || !val(enc, 'repeat_buff')) return;
    if (tgt !== u) { croak(u, u, a); return; }
    const r = val(a, 'abilitycastrange') + u.s.castRange;
    const near = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true }).filter((x) => x !== u && x.kind === 'hero')
      .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
    if (near) croak(u, near, a);
  },
});

defineAbility({ key: 'largo_encore', target: 'passive', innate: true, noIllusion: true });

// ---------------- Amphibian Rhapsody y canciones ----------------

const SONGS = ['largo_song_fight_song', 'largo_song_double_time', 'largo_song_good_vibrations'];
const rhapsodyOf = (u: Unit) => abil(u, 'largo_amphibian_rhapsody');
const songOn = (u: Unit) => !!heroOf(u).findMod('amphibian_rhapsody');

/** Índice del pulso más cercano y si el instante actual cae dentro del margen. */
function beatInfo(u: Unit) {
  const m = heroOf(u).findMod('amphibian_rhapsody');
  const r = rhapsodyOf(u);
  if (!m || !r) return null;
  const every = val(r, 'rhythm_interval');
  const t = u.w.time - m.data.start;
  const beat = Math.round(t / every);
  const onBeat = Math.abs(t - beat * every) <= val(r, 'rhythm_grace_period') / 2;
  return { m, r, beat, onBeat };
}

function groovin(u: Unit, r: AbilityInst) {
  return u.findMod('groovin') ?? u.addMod({
    name: 'groovin', duration: Infinity, stacks: 0, fx: 'groovin',
    props: (m) => ({ armor: m.stacks * val(r, 'armor_per_stack') }),
    // Talento: los aliados cercanos reciben parte de la armadura.
    aura: {
      radius: val(r, 'radius'), team: 'ally', heroesOnly: true, includeSelf: false,
      apply: (m) => ({ name: 'groovin_ally', props: { armor: m.stacks * val(r, 'armor_per_stack') * val(r, 'armor_ally_pct') / 100 } }),
    },
  }, u, r);
}

/** Rasgueo: devuelve true si cuenta (a ritmo y sin repetir pulso, salvo doble canción). */
function strum(u: Unit, song: AbilityInst): { ok: boolean; double: boolean; stacks: number } {
  const b = beatInfo(u);
  if (!b) return { ok: false, double: false, stacks: 0 };
  const { m, r, beat, onBeat } = b;
  const played: string[] = m.data.played[beat] ?? (m.data.played[beat] = []);
  const g = groovin(u, r);
  const max = val(song, 'double_song') ? 2 : 1;
  // Las canciones cuestan menos con Groovin': se devuelve la diferencia.
  giveMana(u, Math.min(manaCostOf(song), g.stacks * val(song, 'song_cost_reduction_per_stack')));
  if (!onBeat || played.length >= max || played.includes(song.key)) return { ok: false, double: false, stacks: g.stacks };
  played.push(song.key);
  if (played.length === 1) {
    g.stacks = Math.min(val(r, 'max_stacks'), g.stacks + 1);
    g.remaining = Infinity;
    u.refreshStats();
  }
  u.w.emit({ n: 'strum', x: u.x, y: u.y, u: u.id, r: val(song, 'radius'), t: u.team });
  return { ok: true, double: played.length > 1, stacks: g.stacks };
}

function rhapsodyMod(u: Unit, a: AbilityInst): ModSpec {
  return {
    name: 'amphibian_rhapsody', duration: Infinity, states: ST.disarmed, fx: 'rhapsody',
    data: { start: u.w.time, played: {} as Record<number, string[]>, checked: 0 },
    onTick(m) {
      // Pulso que pasa sin rasgueo: pierde una acumulación.
      const every = val(a, 'rhythm_interval'), grace = val(a, 'rhythm_grace_period') / 2;
      const t = u.w.time - m.data.start;
      while ((m.data.checked + 1) * every + grace < t) {
        m.data.checked++;
        const g = u.findMod('groovin');
        if (!m.data.played[m.data.checked]?.length && g && g.stacks > 0) { g.stacks--; u.refreshStats(); }
        delete m.data.played[m.data.checked - 2];
      }
    },
    onDestroy() {
      const g = u.findMod('groovin');
      if (!g) return;
      g.stacks = Math.max(0, g.stacks - val(a, 'stack_decrement_on_exit'));
      g.remaining = dur(a, 'stack_duration');
      u.refreshStats();
    },
  };
}

/** IA del bot: activa la canción en pelea y rasguea a ritmo. */
function rhapsodyBrain(a: AbilityInst): ModSpec {
  return {
    name: 'rhapsody_brain', persistent: true,
    onDeath() { a.toggled = false; },
    onTick(m, dt) {
      const u = m.owner as Unit;
      m.data.t = (m.data.t ?? 0) - dt;
      if (m.data.t > 0) return;
      m.data.t = 0.1;
      if (!u.isBot || !u.alive || u.cast || u.kind !== 'hero') return;
      const near = nearestEnemyHero(u, val(a, 'radius'));
      const on = songOn(u);
      if (!on && near && ready(a) && u.mana > u.s.maxMana * 0.25) { u.w.issueOrder(u, { type: 'cast', slot: a.slot }); return; }
      if (on && ((!nearestEnemyHero(u, 1300) && ready(a)) || u.mana < 30)) { u.w.issueOrder(u, { type: 'cast', slot: a.slot }); return; }
      if (!on) return;
      const b = beatInfo(u);
      if (!b || !b.onBeat) return;
      const played: string[] = b.m.data.played[b.beat] ?? [];
      const songs = SONGS.map((k) => abil(u, k)).filter((s): s is AbilityInst => !!s && s.level > 0);
      const max = songs[0] && val(songs[0], 'double_song') ? 2 : 1;
      if (played.length >= max) return;
      const hurt = hurtAlly(u, val(a, 'radius'), 0.7);
      const want = hurt ? 'largo_song_good_vibrations'
        : b.beat % 3 === 2 ? 'largo_song_double_time' : near ? 'largo_song_fight_song' : 'largo_song_double_time';
      const order = [want, ...SONGS.filter((k) => k !== want)];
      for (const k of order) {
        const s = songs.find((x) => x.key === k);
        if (s && !played.includes(k) && ready(s)) { u.w.issueOrder(u, { type: 'cast', slot: s.slot }); return; }
      }
    },
  };
}

defineAbility({
  key: 'largo_amphibian_rhapsody', target: 'toggle', ult: true,
  passive: (a) => rhapsodyBrain(a),
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!on) { u.removeModsByName('amphibian_rhapsody'); return; }
    u.atk.phase = 0;
    u.addMod(rhapsodyMod(u, a), u, a);
    groovin(u, a).remaining = Infinity;
  },
});

const songHidden = (a: AbilityInst) => !songOn(a.owner as Unit);

defineAbility({
  key: 'largo_song_fight_song', target: 'none', hidden: songHidden, levelWith: 4,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const s = strum(u, a);
    if (!s.ok) return;
    const r = val(a, 'radius');
    // Con Scepter, al tocarla en doble rasgueo hace daño extra por acumulación.
    const extra = s.double ? val(a, 'damage_per_stack') * s.stacks : 0;
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { immune: false })) {
      if (e.kind !== 'ward') damage(u, e, dmg(a, 'burst_damage') + extra, 'magical', a);
    }
    for (const al of u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })) {
      al.addMod({
        name: 'bullbelly_blitz', duration: buffDur(u, dur(a, 'battle_burst_duration')), fx: 'fight_song',
        props: { spellAmp: val(a, 'spell_amp_bonus') / 100 },
        onAttackLanded(_m, ev) {
          const v = ev.target as Unit;
          if (v.team !== al.team && !v.has(ST.magicImmune)) damage(al, v, val(a, 'magic_damage_bonus'), 'magical', a, { noProc: true });
        },
      }, u, a);
    }
  },
});

defineAbility({
  key: 'largo_song_double_time', target: 'none', hidden: songHidden, levelWith: 4,
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!strum(u, a).ok) return;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'))) {
      if (al.kind === 'ward') continue;
      al.addMod({ name: 'hotfeet_hustle', duration: buffDur(u, dur(a, 'movement_burst_duration')), fx: 'haste',
        props: { msPct: val(a, 'movespeed_bonus_burst') / 100 } }, u, a);
      al.addMod({ name: 'hotfeet_hustle_resist', duration: buffDur(u, dur(a, 'slow_resistance_burst_duration')),
        props: { slowResist: val(a, 'slow_resistance') / 100 } }, u, a);
    }
  },
});

defineAbility({
  key: 'largo_song_good_vibrations', target: 'none', hidden: songHidden, levelWith: 4,
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!strum(u, a).ok) return;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'), { heroes: true })) heal(al, dmg(a, 'heal_burst'), u);
  },
});

defineHero('largo', [
  'largo_catchy_lick', 'largo_frogstomp', 'largo_croak_of_genius', 'largo_encore', 'largo_amphibian_rhapsody',
  'largo_song_fight_song', 'largo_song_double_time',
  // Tercera canción (Island Elixir): el dataset la mete entre los talentos.
  'largo_song_good_vibrations',
], {
  build: ['magic_wand', 'arcane_boots', 'blink', 'pipe', 'guardian_greaves', 'ultimate_scepter', 'heart'],
});
