import type { ClassifiedQuestionIntent } from "../services/tableauMcpToolPlanner";
import type {
  DashboardContext,
  QuestionInterpretation,
  TableauAdditionalContext,
} from "../types/tableau";
import type { AuthenticatedUser } from "../types/auth";

export type GetAdditionalContextInput = {
  dashboardContext: DashboardContext;
  question: string;
  planningQuestion?: string;
  questionInterpretation?: QuestionInterpretation;
  intentHint?: ClassifiedQuestionIntent;
  authenticatedUser?: AuthenticatedUser;
  tableauSubject?: string;
};

export interface TableauContextProvider {
  readonly name: TableauAdditionalContext["provider"];
  getAdditionalContext(
    input: GetAdditionalContextInput,
  ): Promise<TableauAdditionalContext>;
}
