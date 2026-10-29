'use strict';

// Creates data/warehouse.db: a small demo "company database" for the data gateway.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function seedWarehouse(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.rmSync(file);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE renewals (mesiac TEXT, kanal TEXT, tarifa TEXT, region TEXT, koncace INTEGER, predlzenia INTEGER, poplatok REAL, email_zakaznika TEXT)`);
  const ins = db.prepare('INSERT INTO renewals VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const channels = ['Predajne', 'Online', 'Telepredaj', 'Partneri'];
  const tariffs = [['Mini', 9.9], ['Štandard', 19.9], ['Premium', 34.9]];
  const regions = ['Západ', 'Stred', 'Východ'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  db.exec('BEGIN');
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 9) break;
      const month = `${y}-${String(m).padStart(2, '0')}`;
      for (const ch of channels) for (const [t, fee] of tariffs) for (const r of regions) {
        const ending = Math.round(80 + rnd() * 120);
        ins.run(month, ch, t, r, ending, Math.round(ending * (0.6 + rnd() * 0.25)), fee, `zakaznik${Math.floor(rnd() * 1e6)}@example.com`);
      }
    }
  }
  db.exec('COMMIT');
  db.close();
}

if (require.main === module) {
  const file = path.join(__dirname, '..', 'data', 'warehouse.db');
  seedWarehouse(file);
  console.log(`Demo warehouse created: ${file}`);
}

module.exports = { seedWarehouse };
