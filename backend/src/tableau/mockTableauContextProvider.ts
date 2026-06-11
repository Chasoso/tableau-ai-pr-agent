import type { TableauAdditionalContext } from "../types/tableau";
import type {
  GetAdditionalContextInput,
  TableauContextProvider,
} from "./contextProvider";

export class MockTableauContextProvider implements TableauContextProvider {
  readonly name = "mock" as const;

  async getAdditionalContext(
    input: GetAdditionalContextInput,
  ): Promise<TableauAdditionalContext> {
    return {
      provider: this.name,
      workbook: {
        name: input.dashboardContext.workbookName ?? "Mock workbook",
      },
      datasources: input.dashboardContext.dataSources ?? [],
      metadata: {
        note: "Mock provider did not call Tableau REST API or Metadata API.",
      },
      warnings: [],
    };
  }
}
