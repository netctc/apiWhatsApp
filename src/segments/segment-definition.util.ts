import { ConsentStatus, Prisma } from "../generated/prisma/client.js";

export interface SegmentDefinitionInput {
  language?: string;
  tagsAny?: string[];
  tagsAll?: string[];
}

export interface NormalizedSegmentDefinition {
  language?: string;
  tagsAny?: string[];
  tagsAll?: string[];
}

export class SegmentDefinitionError extends Error {}

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const MAX_TAGS_PER_FILTER = 50;
const MAX_LANGUAGE_LENGTH = 20;

export function normalizeSegmentDefinition(
  input: SegmentDefinitionInput | undefined,
): NormalizedSegmentDefinition {
  if (!input || typeof input !== "object") {
    throw new SegmentDefinitionError("Segment definition is required");
  }

  const language = input.language?.trim();
  if (language && language.length > MAX_LANGUAGE_LENGTH) {
    throw new SegmentDefinitionError(
      `Segment language must be at most ${MAX_LANGUAGE_LENGTH} characters`,
    );
  }

  const tagsAny = normalizeTags(input.tagsAny, "tagsAny");
  const tagsAll = normalizeTags(input.tagsAll, "tagsAll");

  if (!language && tagsAny.length === 0 && tagsAll.length === 0) {
    throw new SegmentDefinitionError(
      "Saved segment requires at least one criterion: language, tagsAny, or tagsAll",
    );
  }

  return {
    ...(language ? { language } : {}),
    ...(tagsAny.length > 0 ? { tagsAny } : {}),
    ...(tagsAll.length > 0 ? { tagsAll } : {}),
  };
}

export function readPersistedSegmentDefinition(value: Prisma.JsonValue): NormalizedSegmentDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SegmentDefinitionError("Persisted segment definition is invalid");
  }

  const candidate = value as Record<string, unknown>;
  return normalizeSegmentDefinition({
    ...(typeof candidate.language === "string" ? { language: candidate.language } : {}),
    ...(Array.isArray(candidate.tagsAny)
      ? { tagsAny: candidate.tagsAny.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(candidate.tagsAll)
      ? { tagsAll: candidate.tagsAll.filter((item): item is string => typeof item === "string") }
      : {}),
  });
}

export function segmentContactWhere(
  tenantId: string,
  definition: NormalizedSegmentDefinition,
): Prisma.ContactWhereInput {
  const tags =
    definition.tagsAny || definition.tagsAll
      ? {
          ...(definition.tagsAny ? { hasSome: definition.tagsAny } : {}),
          ...(definition.tagsAll ? { hasEvery: definition.tagsAll } : {}),
        }
      : undefined;

  return {
    tenantId,
    consentStatus: ConsentStatus.OPTED_IN,
    ...(definition.language ? { language: definition.language } : {}),
    ...(tags ? { tags } : {}),
  };
}

function normalizeTags(tags: string[] | undefined, field: string): string[] {
  if (!tags) {
    return [];
  }
  if (tags.length > MAX_TAGS_PER_FILTER) {
    throw new SegmentDefinitionError(
      `${field} cannot contain more than ${MAX_TAGS_PER_FILTER} tags`,
    );
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))].filter(Boolean);
  for (const tag of normalized) {
    if (!TAG_PATTERN.test(tag)) {
      throw new SegmentDefinitionError(`Invalid segment tag '${tag}'`);
    }
  }
  return normalized.sort();
}
