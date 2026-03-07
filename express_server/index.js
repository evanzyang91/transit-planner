import { config } from 'dotenv';
import { resolve } from 'path';

// Load root .env (workspace script runs with cwd = express_server, so root is ..)
config({ path: resolve(process.cwd(), '..', '.env') });

import express from 'express';
import { greet } from 'express_utils';
import { getDb } from 'express_db';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/', (req, res) => {
  const db = getDb();
  res.send(`${greet('World')} (db: ${db.status})`);
});

app.listen(PORT, () => {
  console.log(`Express server listening on http://localhost:${PORT}`);
});
