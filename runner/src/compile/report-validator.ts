import { Ajv, type ErrorObject } from "ajv";

export const CANONICAL_CHECKS = ["build", "typecheck", "test", "lint"] as const;

export interface ReportSchemaError {
  path: string;
  message: string;
}

export class ReportValidationError extends Error {
  errors: ReportSchemaError[];

  constructor(message: string, errors: ReportSchemaError[] = []) {
    super(message);
    this.name = "ReportValidationError";
    this.errors = errors;
  }
}

export interface ReportValidator {
  validateObject(obj: unknown): Record<string, unknown>;
}

function toSchemaErrors(errors: ErrorObject[] | null | undefined): ReportSchemaError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? "invalid",
  }));
}

function summarize(errors: ReportSchemaError[]): string {
  return errors
    .slice(0, 5)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
}

export function createReportValidator(schema: object): ReportValidator {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  return {
    validateObject(obj: unknown): Record<string, unknown> {
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new ReportValidationError("report is not an object", [
          { path: "/", message: "report is not an object" },
        ]);
      }

      if (!validate(obj)) {
        const errors = toSchemaErrors(validate.errors);
        throw new ReportValidationError(
          `report failed schema validation: ${summarize(errors)}`,
          errors,
        );
      }

      return obj as Record<string, unknown>;
    },
  };
}
