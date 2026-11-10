import type { ToolCallEvent, ToolInput } from "../extension/contract.ts";
import { authorizationKey } from "./authorization-key.ts";
import {
  confirmationQuestion,
  confirmationQuestionId,
  releaseConfirmationQuestionId,
  type BoundaryCategory,
} from "./confirmation-question.ts";

export type AskPayload = { html: string };

export function confirmationForm(question: string, questionId: string): string {
  const escapedQuestion = Bun.escapeHTML(question);
  const escapedQuestionId = Bun.escapeHTML(questionId);
  return `<form><fieldset><legend>Repository boundary</legend><p>${escapedQuestion}</p><label><input type="radio" name="${escapedQuestionId}" value="Approve">Approve</label><label><input type="radio" name="${escapedQuestionId}" value="Reject" checked>Reject</label></fieldset></form>`;
}

export type RepositoryMutationHandoff =
  | { decision: "allow"; action?: string; currentRepository?: string; target?: string; input?: ToolInput }
  | {
      decision: "ask";
      action: string;
      category: BoundaryCategory;
      currentRepository?: string;
      target: string;
      fingerprint: string;
      question: string;
      questionId: string;
      ask: AskPayload;
      input?: ToolInput;
    };

export function askHandoff(
  action: string,
  target: string,
  event: ToolCallEvent,
  context: string,
  category: BoundaryCategory,
  currentRepository?: string,
  description?: string,
): Extract<RepositoryMutationHandoff, { decision: "ask" }> {
  const question = confirmationQuestion(action, target, event.input, description, currentRepository, category);
  const questionId = category === "release" ? releaseConfirmationQuestionId : confirmationQuestionId;
  return {
    decision: "ask",
    action,
    category,
    currentRepository,
    target,
    fingerprint: authorizationKey(event.toolName, action, target, event.input, context),
    question,
    questionId,
    ask: { html: confirmationForm(question, questionId) },
  };
}
