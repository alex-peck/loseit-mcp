import { StructParseError, type StructFieldDef, type StructFieldType } from "./structReader.js";

// Field types observed in the web app's serializers. These tools use numbered
// fields; refuse changed layouts rather than interpreting or writing wrong data.
const LAYOUTS: Record<string, readonly StructFieldType[]> = {
  Note: ["string", "int", "boolean", "int", "string", "int", "long", "obj"],
  CustomGoal: ["obj", "double", "boolean", "string", "obj", "obj", "double", "double", "string", "obj", "string", "string", "obj", "obj", "obj", "double", "string", "long", "obj"],
  CustomGoalValue: ["obj", "obj", "boolean", "obj", "obj", "double", "long", "obj"],
  Exercise: ["int", "int", "string", "double", "string", "string", "long", "obj"],
  ExerciseCategory: ["int", "obj", "int", "string", "boolean", "string", "string", "long", "obj"],
  ExerciseLogEntry: ["obj", "double", "obj", "boolean", "obj", "obj", "boolean", "int", "boolean", "int", "boolean", "long", "obj"],
  SearchResultExercise: ["obj", "string", "string", "string", "int", "obj", "obj", "int"],
  CalorieBurnMetrics: ["obj", "double", "double"],
};

export function validateLoggingModels(registry: ReadonlyMap<string, StructFieldDef[]>, models: readonly string[]): void {
  for (const name of models) {
    const types = LAYOUTS[name];
    const fields = registry.get(name);
    if (!types || !fields) throw new StructParseError(`Missing logging model ${name}`);
    if (fields.length !== types.length || fields.some((field, index) =>
      field.type !== types[index] || field.name !== `f${index}`)) {
      throw new StructParseError(`Lose It's ${name} model changed; logging tools need an update`);
    }
  }
}
