// Regenera shared/heroes/index.ts con un import por cada fichero de héroe.
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../shared/heroes');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'util.ts').sort();
writeFileSync(join(dir, 'index.ts'),
  '// Generado por scripts/gen-hero-index.ts: registra todos los héroes jugables.\n' +
  files.map((f) => `import './${f.replace(/\.ts$/, '')}';`).join('\n') + '\n');
console.log(`${files.length} héroes en el índice`);
