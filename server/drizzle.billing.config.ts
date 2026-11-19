import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the ISOLATED credit-ledger migration folder
 * (`server/billing-drizzle`, #64). Deliberately separate from the app's
 * `server/drizzle` folder and `drizzle.config.ts`: the ledger owns its own
 * journal (`billing.__drizzle_migrations`) and can initialize an empty
 * database without touching the application identity tables, and the app's
 * `db:generate` never picks up ledger tables by accident.
 */
export default defineConfig({
  schema: "./src/billing-ledger/schema.ts",
  out: "./billing-drizzle",
  dialect: "postgresql",
  strict: false,
  verbose: false,
});
