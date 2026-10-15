// Tipos del motor. Imitan el modelo de Dota: todo lo que altera a una unidad es un
// modificador con propiedades, estados y eventos; habilidades e items solo crean modificadores,
// proyectiles y daño.
import type { AbilityData, HeroData, ItemData } from '../data';

export type DamageType = 'physical' | 'magical' | 'pure';
export type UnitKind = 'hero' | 'illusion' | 'creep' | 'summon' | 'ward' | 'fountain' | 'kobold' | 'throne' | 'orb';

/** Estados como bits para poder mandarlos en un solo número por la red. */
export const ST = {
  stunned: 1 << 0,
  silenced: 1 << 1,
  rooted: 1 << 2,
  disarmed: 1 << 3,
  hexed: 1 << 4,
  invisible: 1 << 5,
  magicImmune: 1 << 6,
  invulnerable: 1 << 7,
  /** Fuera del mundo a efectos de objetivo (ciclón, Doppelganger, Omnislash). */
  untargetable: 1 << 8,
  muted: 1 << 9,
  taunted: 1 << 10,
  noCollision: 1 << 11,
  revealed: 1 << 12,
  ethereal: 1 << 13,
  channeling: 1 << 14,
  hidden: 1 << 15,
  /** Bajo control de una habilidad (Omnislash): no obedece órdenes. */
  busy: 1 << 16,
  /** Break: las pasivas de habilidades dejan de funcionar. */
  broken: 1 << 17,
  /** Vuela: ignora árboles y terreno al moverse y al ver. */
  flying: 1 << 18,
  /** Disipación: no se le puede curar (Doom). */
  disarmedSpells: 1 << 19,
} as const;

/** Propiedades sumables. Los % se expresan como fracción (0.2 = 20%). */
export interface Props {
  str: number; agi: number; int: number; allStats: number;
  /** Multiplicador de atributos base (Bladeform). */
  agiBasePct: number;
  damage: number; damagePct: number; attackSpeed: number;
  armor: number;
  /** Resistencia mágica: cada fuente se combina multiplicativamente. */
  magicResist: number;
  msFlat: number; msPct: number; msSlow: number; msFixed: number;
  hp: number; mana: number; hpRegen: number; manaRegen: number;
  hpRegenPct: number; hpRegenAmp: number; manaRegenAmp: number;
  evasion: number; spellAmp: number; attackRange: number; castRange: number;
  statusResist: number; slowResist: number; lifesteal: number; spellLifesteal: number;
  incomingPct: number; outgoingPct: number; damageBlock: number; vision: number;
  attackSlow: number;
  /** Reducción de enfriamiento (fracción, se combina multiplicativamente). */
  cdr: number;
  /** Reducción de coste de maná (fracción). */
  manaReduce: number;
  /** Amplificación de curación recibida (fracción). */
  healAmp: number;
  /** Amplificación de experiencia ganada (fracción). */
  xpGain: number;
  /** Segundos menos de reaparición. */
  respawnReduce: number;
  /** Radio de true sight (ver invisibles). */
  trueSight: number;
  /** Daño de barrido (fracción) para cuerpo a cuerpo. */
  cleave: number;
  /** Límite de velocidad de movimiento por encima de 550 (Chronosphere, haste…). */
  msMax: number;
  /** Alcance de ataque extra que también reciben los cuerpo a cuerpo. */
  meleeRange: number;
  /** Probabilidad de fallar sus propios ataques (ceguera). */
  missChance: number;
  /** Tiempo base de ataque que sustituye al del héroe si es > 0 (gana el más bajo). */
  batOverride: number;
}
export type PropKey = keyof Props;

export interface DamageEvent {
  source: Unit | null;
  target: Unit;
  amount: number;
  type: DamageType;
  /** Habilidad o item que causa el daño; null para ataques normales. */
  ability: AbilityInst | ItemInst | null;
  isAttack: boolean;
  /** No se refleja, no dispara lifesteal ni Counter Helix (daño de auras, DoT…). */
  noProc?: boolean;
  /** Pérdida de vida sin tipo (Culling Blade, drenaje de Armlet). */
  hpRemoval?: boolean;
  crit?: boolean;
  data?: Record<string, any>;
}

export interface AttackEvent {
  attacker: Unit;
  target: Unit;
  /** Daño de ataque físico ya calculado; los modificadores pueden alterarlo. */
  damage: number;
  /** Daño extra por crítico (multiplicador elegido, 1 = sin crítico). */
  critMult: number;
  /** Ataque que no puede fallar (MKB, Javelin…). */
  trueStrike: boolean;
  missed: boolean;
  /** Ataques generados (Omnislash, Echo Sabre) no disparan algunos efectos. */
  fake: boolean;
  distance: number;
}

export interface Modifier {
  name: string;
  caster: Unit | null;
  ability: AbilityInst | ItemInst | null;
  /** Segundos restantes; Infinity = permanente. */
  remaining: number;
  duration: number;
  stacks: number;
  debuff: boolean;
  purgable: boolean;
  /** Se quita al morir (por defecto sí, salvo pasivas). */
  persistent?: boolean;
  props?: Partial<Props> | ((m: Modifier) => Partial<Props>);
  states?: number;
  /** Aura: aplica `aura.apply()` a las unidades del radio y la renueva cada tick. */
  aura?: AuraSpec;
  interval?: number;
  acc?: number;
  /** Nombre del efecto visual que el cliente puede dibujar (stun, slow, blade_fury…). */
  fx?: string;
  data: Record<string, any>;
  owner?: Unit;
  onCreated?(m: Modifier): void;
  onDestroy?(m: Modifier): void;
  onInterval?(m: Modifier): void;
  onTick?(m: Modifier, dt: number): void;
  /** Ataque del dueño lanzado (para críticos y true strike). */
  onAttackStart?(m: Modifier, ev: AttackEvent): void;
  /** Ataque del dueño que impacta. */
  onAttackLanded?(m: Modifier, ev: AttackEvent): void;
  /** Ataque recibido por el dueño (Counter Helix). */
  onAttacked?(m: Modifier, ev: AttackEvent): void;
  /** Daño recibido por el dueño, antes de aplicarse; puede reducir ev.amount. */
  onIncomingDamage?(m: Modifier, ev: DamageEvent): void;
  onTakeDamage?(m: Modifier, ev: DamageEvent): void;
  onDealDamage?(m: Modifier, ev: DamageEvent): void;
  onKill?(m: Modifier, victim: Unit): void;
  /** Otra unidad del mundo muere (Flesh Heap). */
  onAnyDeath?(m: Modifier, victim: Unit, killer: Unit | null): void;
  onDeath?(m: Modifier, killer: Unit | null): void;
  onRespawn?(m: Modifier): void;
  /** El dueño recibe una orden (para cancelar canalizaciones propias, Phantom Rush…). */
  onOrder?(m: Modifier, o: Order): void;
  /** El dueño lanza una habilidad (Fiery Soul, Magic Stick ajeno…). */
  onAbilityExecuted?(m: Modifier, a: AbilityInst | ItemInst): void;
  /** Una habilidad enemiga con objetivo apunta al dueño; devolver true la bloquea. */
  onTargeted?(m: Modifier, caster: Unit, a: AbilityInst | ItemInst): boolean;
}

export interface AuraSpec {
  radius: number;
  team: 'ally' | 'enemy';
  heroesOnly?: boolean;
  global?: boolean;
  includeSelf?: boolean;
  /** Crea el modificador que lleva cada unidad afectada; dura 0.5 s y se renueva. */
  apply(m: Modifier, target: Unit): ModSpec;
}

export type ModSpec = Partial<Omit<Modifier, 'remaining' | 'stacks' | 'data'>> & {
  name: string;
  duration?: number;
  stacks?: number;
  data?: Record<string, any>;
};

export type TargetKind = 'none' | 'unit' | 'point' | 'unitOrPoint' | 'passive' | 'toggle';

export interface CastTarget { unit?: Unit; x: number; y: number }

/** Comportamiento de una habilidad. Los números salen de AbilityData.values. */
export interface AbilityImpl {
  key: string;
  target: TargetKind;
  team?: 'enemy' | 'ally' | 'any';
  ult?: boolean;
  /** Innata: nivel fijo 1, no consume puntos. */
  innate?: boolean;
  /** Oculta en la barra (true) o según el estado (función), p. ej. el Return de X Marks the Spot. */
  hidden?: boolean | ((a: AbilityInst) => boolean);
  allowSelf?: boolean;
  /** Se lanza aunque el punto quede fuera de alcance (Blink lo recorta). */
  castBeyond?: boolean;
  castRange?(a: AbilityInst): number;
  castPoint?(a: AbilityInst): number;
  channel?(a: AbilityInst): number;
  aoe?(a: AbilityInst): number;
  /** Cargas (Shrapnel): devuelve [máximo, segundos por carga]. */
  charges?(a: AbilityInst): [number, number];
  /** Pasiva intrínseca; se recrea al subir de nivel. */
  passive?(a: AbilityInst): ModSpec | null;
  onSpellStart?(a: AbilityInst, t: CastTarget): void;
  onChannelTick?(a: AbilityInst, dt: number): void;
  onChannelEnd?(a: AbilityInst, interrupted: boolean): void;
  onToggle?(a: AbilityInst, on: boolean): void;
  onLevelUp?(a: AbilityInst): void;
  /** Se puede reflejar con Counterspell / Lotus. */
  reflectable?: boolean;
  /** Pistas para los bots. */
  ai?: AiHint;
  /** Solo disponible con Aghanim's Scepter o Shard (si no, se oculta). */
  requires?: 'scepter' | 'shard';
  /** Nivel que sigue al de otra habilidad (por hueco), p. ej. sub-habilidades de la ulti. */
  levelWith?: number;
  /** Se llama al conseguir o perder Scepter/Shard. */
  onAghs?(a: AbilityInst): void;
  /** Las ilusiones también tienen esta habilidad activa (pasivas de ataque, sí; auras, no). */
  noIllusion?: boolean;
  /** Sub-habilidad sin hueco visible propio (se lanza desde otra). */
  sub?: boolean;
  /** Condición extra para poder lanzarla (devuelve el motivo si no se puede). */
  check?(a: AbilityInst): string | null;
  /** Se puede usar aturdido (Refraction con Shard, Enrage con Scepter…). */
  usableStunned?: (a: AbilityInst) => boolean;
}

export interface AiHint {
  /** 'nuke' | 'disable' | 'escape' | 'buff' | 'aoe' | 'summon' | 'channel' */
  role: string;
  /** Lanzar solo si el objetivo está por debajo de este % de vida. */
  hpBelow?: number;
  /** Lanzar en uno mismo / al estar cerca de enemigos en este radio. */
  selfRadius?: number;
}

export interface AbilityInst {
  key: string;
  def: AbilityData;
  impl: AbilityImpl;
  owner: Unit;
  level: number;
  cd: number;
  charges: number;
  chargeCd: number;
  toggled: boolean;
  /** Mejoras de orbe de Overthrow: multiplicadores sobre daño y enfriamiento. */
  upg: { dmg: number; cd: number; dur: number; range: number };
  /** Mejoras por valor concreto: se suman (bonus) o multiplican (mult) al valor del dataset. */
  bonus: Record<string, number>;
  mult: Record<string, number>;
  passiveMod: Modifier | null;
  /** Habilidad temporal (reflejada): no tiene dueño real. */
  temp?: boolean;
  data: Record<string, any>;
  slot: number;
}

export interface ItemImpl {
  key: string;
  target: TargetKind;
  team?: 'enemy' | 'ally' | 'any';
  allowSelf?: boolean;
  castBeyond?: boolean;
  /** Condición extra para poder usarlo (Blink tras recibir daño). */
  check?(it: ItemInst): string | null;
  castRange?(it: ItemInst): number;
  castPoint?: number;
  channel?(it: ItemInst): number;
  /** Modificador pasivo propio (además de los stats genéricos). */
  passive?(it: ItemInst): ModSpec | null;
  onSpellStart?(it: ItemInst, t: CastTarget): void;
  onChannelTick?(it: ItemInst, dt: number): void;
  onChannelEnd?(it: ItemInst, interrupted: boolean): void;
  onToggle?(it: ItemInst, on: boolean): void;
  /** Se consume al gastar la última carga. */
  consumable?: boolean;
  reflectable?: boolean;
  ai?: AiHint;
}

export interface ItemInst {
  key: string;
  def: ItemData;
  impl: ItemImpl | null;
  owner: Unit;
  cd: number;
  charges: number;
  toggled: boolean;
  /** Para Power Treads y similares. */
  mode: number;
  passiveMod: Modifier | null;
  boughtAt: number;
  data: Record<string, any>;
  /** Slot actual en el inventario (0-5 activos, 6-8 mochila). */
  slot: number;
  isItem: true;
}

export type Order =
  | { type: 'move'; x: number; y: number }
  | { type: 'attackMove'; x: number; y: number }
  | { type: 'attack'; target: number }
  | { type: 'follow'; target: number }
  | { type: 'stop' }
  | { type: 'hold' }
  | { type: 'cast'; slot: number; target?: number; x?: number; y?: number }
  | { type: 'item'; slot: number; target?: number; x?: number; y?: number };

export interface Fx {
  /** Nombre del efecto: 'aoe', 'beam', 'number', 'blink', 'hook'… */
  n: string;
  x: number; y: number;
  x2?: number; y2?: number;
  r?: number;
  d?: number;
  u?: number;
  u2?: number;
  v?: number;
  c?: string;
  /** Equipo que lo provoca, para colorear. */
  t?: number;
  /** Habilidad o item que lo provoca (lo rellena el mundo si se emite durante un lanzamiento). */
  a?: string;
}

export interface Projectile {
  id: number;
  /** Habilidad o item que lo lanzó (para elegir su aspecto). */
  ability?: string;
  kind: 'track' | 'linear';
  /** Visual: 'attack', 'dragon_slave', 'hook', 'lance', 'assassinate'… */
  fx: string;
  source: Unit;
  target: Unit | null;
  x: number; y: number;
  dx: number; dy: number;
  speed: number;
  /** Lineales: distancia restante y ancho. */
  left: number;
  width: number;
  widthEnd: number;
  travelled: number;
  hit: Set<number>;
  dodgeable: boolean;
  team: number;
  /** Devolver true termina el proyectil. */
  onHit(p: Projectile, u: Unit): boolean | void;
  onEnd?(p: Projectile): void;
  onThink?(p: Projectile, dt: number): void;
  dead: boolean;
}

/** Interfaz mínima de la unidad que usan los tipos de arriba; la clase está en unit.ts. */
export interface Unit {
  id: number;
  kind: UnitKind;
  team: number;
  name: string;
  hero: HeroData | null;
  playerId: string | null;
  x: number; y: number; facing: number;
  radius: number;
  alive: boolean;
  hp: number; mana: number;
  level: number; xp: number;
  abilities: AbilityInst[];
  items: (ItemInst | null)[];
  mods: Modifier[];
  s: Stats;
  owner: Unit | null;
  [k: string]: any;
}

export interface Stats {
  str: number; agi: number; int: number;
  maxHp: number; maxMana: number; hpRegen: number; manaRegen: number;
  armor: number; mr: number; dmgMin: number; dmgMax: number; dmgBonus: number;
  as: number; bat: number; attackRange: number; ms: number;
  evasion: number; spellAmp: number; castRange: number; statusResist: number;
  slowResist: number; lifesteal: number; spellLifesteal: number;
  incomingPct: number; outgoingPct: number; damageBlock: number; vision: number;
  cdr: number; manaReduce: number; healAmp: number; xpGain: number; respawnReduce: number; trueSight: number; cleave: number;
  missChance: number;
  states: number;
}
