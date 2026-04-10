const { Pool } = require('pg');
const { PostgresStore } = require('wwebjs-postgres');

const pool = new Pool();
try {
  const store = new PostgresStore({ pool: pool });
  console.log("Success with pool: pool");
} catch(e) {
  console.log("Error:", e.message);
}
