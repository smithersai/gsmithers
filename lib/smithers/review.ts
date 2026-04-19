// Shared schemas for the gstack plan-review and PR-review skill family.
// Upstream skills (plan-ceo-review, plan-eng-review, plan-design-review,
// plan-devex-review, review) each produce structurally similar findings;
// collecting them here lets autoplan merge them without translating shapes.
import { z } from "zod/v4";

export const severitySchema = z.enum(["critical", "major", "minor", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

export const reviewFindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: severitySchema,
  category: z.string(),
  location: z.string().nullable().default(null),
  rationale: z.string(),
  recommendation: z.string(),
  /** Optional proposed edit — populated when the review also fixes. */
  proposedEdit: z.string().nullable().default(null),
});

export const reviewScoreSchema = z.object({
  dimension: z.string(),
  score: z.number().int().min(0).max(10),
  whatWouldMakeItTen: z.string(),
});

export const reviewOutputSchema = z.object({
  summary: z.string(),
  verdict: z.enum([
    "ship",
    "ship_with_changes",
    "revise_substantially",
    "hold",
  ]),
  findings: z.array(reviewFindingSchema).default([]),
  scores: z.array(reviewScoreSchema).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
