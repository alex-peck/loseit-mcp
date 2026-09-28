import type { GwtResponse } from "./gwt.js";
import { StructReader, StructParseError, type StructFieldDef } from "./structReader.js";

type GwtObject = Record<string, unknown>;

function object(value: unknown): GwtObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StructParseError("Unexpected food search response object");
  }
  return value as GwtObject;
}

export interface FoodSearchItem {
  foodId: string;
  name: string;
  brand: string;
  /** Search context required by Lose It when loading this food for logging. */
  source: string | null;
}

export interface FoodSearchResult {
  foods: FoodSearchItem[];
  totalResults: number;
}

export function extractFoodSearch(
  raw: GwtResponse,
  registry: Map<string, StructFieldDef[]> | null,
): FoodSearchResult {
  if (!registry) {
    throw new StructParseError(
      "Food search requires the live GWT model registry; check GWT auto-discovery",
    );
  }
  const reader = new StructReader(raw.values, raw.stringTable, registry, new Set());
  const response = object(reader.readObject());
  if (reader.remaining !== 0 || response._cls !== "LoseItRemoteServiceResponse") {
    throw new StructParseError("Unexpected food search response envelope");
  }
  const results = object(response.f3);
  if (results._cls !== "SearchResults" || !Array.isArray(results.f0)) {
    throw new StructParseError("Food search did not return SearchResults");
  }
  const foods: FoodSearchItem[] = [];
  for (const item of results.f0) {
    const row = object(item);
    if (row._cls !== "SearchResultFood") continue;
    const key = object(row.f0);
    const bytes = key.f0;
    if (
      key._cls !== "SimplePrimaryKey" ||
      !Array.isArray(bytes) ||
      bytes.length !== 16 ||
      !bytes.every((byte) => Number.isInteger(byte) && byte >= -128 && byte <= 127) ||
      typeof row.f3 !== "string" ||
      (row.f2 !== null && typeof row.f2 !== "string")
    ) {
      throw new StructParseError("Unrecognized food search result model");
    }
    foods.push({
      foodId: Buffer.from(bytes).toString("base64url"),
      name: row.f3,
      brand: typeof row.f4 === "string" ? row.f4 : "",
      source: row.f2,
    });
  }
  return { foods, totalResults: results.f0.length };
}
