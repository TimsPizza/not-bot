import { and, eq } from "drizzle-orm";
import type { PersonaDefinition } from "@/types";
import { getDb } from "../client";
import { personas } from "../schema";

export type PersonaScope = "builtin" | "custom";

export type PersonaRecord = PersonaDefinition & {
  scope: PersonaScope;
  serverId: string | null;
  isActive: boolean;
};

function rowToPersona(row: typeof personas.$inferSelect): PersonaRecord {
  return {
    id: row.personaId,
    name: row.name,
    description: row.description,
    details: row.details,
    scope: (row.scope as PersonaScope) ?? "builtin",
    serverId: row.serverId ?? null,
    isActive: Boolean(row.isActive),
  };
}

export function upsertPersona(
  definition: PersonaDefinition,
  scope: PersonaScope,
  serverId: string | null,
  isActive = true,
): void {
  const db = getDb();
  const now = Date.now();

  db
    .insert(personas)
    .values({
      personaId: definition.id,
      scope,
      serverId,
      name: definition.name,
      description: definition.description,
      details: definition.details,
      isActive,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: personas.personaId,
      set: {
        scope,
        serverId,
        name: definition.name,
        description: definition.description,
        details: definition.details,
        isActive,
        updatedAt: now,
      },
    })
    .run();
}

export function getPersonaById(personaId: string): PersonaRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(personas)
    .where(eq(personas.personaId, personaId))
    .get();
  return row ? rowToPersona(row) : null;
}

export function listBuiltInPersonas(): PersonaRecord[] {
  const db = getDb();
  return db
    .select()
    .from(personas)
    .where(eq(personas.scope, "builtin"))
    .all()
    .map(rowToPersona);
}

export function listCustomPersonas(serverId: string): PersonaRecord[] {
  const db = getDb();
  return db
    .select()
    .from(personas)
    .where(and(eq(personas.serverId, serverId), eq(personas.scope, "custom")))
    .all()
    .map(rowToPersona);
}

export function deleteCustomPersona(serverId: string, personaId: string): void {
  const db = getDb();
  db
    .delete(personas)
    .where(
      and(
        eq(personas.personaId, personaId),
        eq(personas.scope, "custom"),
        eq(personas.serverId, serverId),
      ),
    )
    .run();
}

export function bulkUpsertBuiltins(personasList: PersonaDefinition[]): void {
  const db = getDb();
  const now = Date.now();

  db.transaction((tx) => {
    tx.delete(personas).where(eq(personas.scope, "builtin")).run();

    if (!personasList.length) {
      return;
    }

    const values = personasList.map((persona) => ({
      personaId: persona.id,
      scope: "builtin" as const,
      serverId: null,
      name: persona.name,
      description: persona.description,
      details: persona.details,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }));

    tx.insert(personas).values(values).run();
  });
}
