-- One active occupancy per room (PLAN §4.1 #11). Partial unique index — not expressible in
-- Prisma schema, applied as raw SQL.
CREATE UNIQUE INDEX IF NOT EXISTS "occupancies_active_room_unique"
  ON "occupancies" ("room_id")
  WHERE "status" = 'active';
