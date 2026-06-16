import type { ClassifiedQuestionIntent } from "../services/tableauMcpToolPlanner";
import type {
  DashboardContext,
  QuestionInterpretation,
  TableauAdditionalContext,
} from "../types/tableau";
import type { AuthenticatedUser } from "../types/auth";
import type { TableauDirectTrustAuthContext } from "./tableauDirectTrustAuth";

export type GetAdditionalContextInput = {
  dashboardContext: DashboardContext;
  question: string;
  planningQuestion?: string;
  questionInterpretation?: QuestionInterpretation;
  intentHint?: ClassifiedQuestionIntent;
  authenticatedUser?: AuthenticatedUser;
  tableauSubject?: string;
  tableauAuth?: TableauDirectTrustAuthContext;
};

export interface TableauContextProvider {
  readonly name: TableauAdditionalContext["provider"];
  getAdditionalContext(
    input: GetAdditionalContextInput,
  ): Promise<TableauAdditionalContext>;
}
