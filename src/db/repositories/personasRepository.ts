import type {
  EmotionMetric,
  EmotionThresholdMap,
  PersonaDefinition,
} from "@/types";
import { and, eq } from "drizzle-orm";
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
    emotionThresholds: parseJson<EmotionThresholdMap>(row.emotionThresholds),
    emotionDeltaCaps: parseJson<Partial<Record<EmotionMetric, number>>>(
      row.emotionDeltaCaps,
    ),
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
      emotionThresholds: serializeJson(definition.emotionThresholds),
      emotionDeltaCaps: serializeJson(definition.emotionDeltaCaps),
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
        emotionThresholds: serializeJson(definition.emotionThresholds),
        emotionDeltaCaps: serializeJson(definition.emotionDeltaCaps),
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
      emotionThresholds: serializeJson(persona.emotionThresholds),
      emotionDeltaCaps: serializeJson(persona.emotionDeltaCaps),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }));

    tx.insert(personas).values(values).run();
  });
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
