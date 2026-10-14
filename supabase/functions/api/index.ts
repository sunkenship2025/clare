// Supabase edge function entry: one function serves the whole clare API.
import postgres from "postgres";
import { createApp } from "../_shared/app.ts";

// SUPABASE_DB_URL is provided to every edge function. prepare:false keeps it pooler-safe.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });

Deno.serve(createApp({ sql, setupSecret: Deno.env.get("CLARE_SETUP_SECRET") }));
