export type Availability = "available" | "notAvailable";

export type WorksheetSummary = {
  name: string;
  sheetType?: string | null;
  size?: {
    width?: number | null;
    height?: number | null;
  };
  summary?: string | null;
};

export type FilterSummary = {
  worksheetName?: string | null;
  fieldName: string;
  filterType?: string | null;
  appliedValues?: string[];
  isAllSelected?: boolean | null;
};

export type ParameterSummary = {
  name: string;
  currentValue?: string | number | boolean | null;
  dataType?: string | null;
  allowableValues?: string[];
};

export type SelectedMarkSummary = {
  worksheetName: string;
  columns?: string[];
  rowCount?: number;
  status?: Availability;
};

export type DataSourceSummary = {
  worksheetName?: string | null;
  name: string;
  id?: string | null;
  fields?: string[] | null;
  fieldsAvailability?: "available" | "not_implemented" | "not_supported";
};

export type ContextAvailability = {
  workbookId: "available" | "not_implemented" | "not_supported";
  viewId: "available" | "not_implemented" | "not_supported";
  datasourceFields: "available" | "not_implemented" | "not_supported";
};

export type DashboardContext = {
  dashboardName: string;
  workbookName?: string | null;
  workbookId?: string | null;
  workbookContentUrl?: string | null;
  viewName?: string | null;
  viewId?: string | null;
  worksheets: WorksheetSummary[];
  filters: FilterSummary[];
  parameters: ParameterSummary[];
  selectedMarks?: SelectedMarkSummary[];
  dataSources?: DataSourceSummary[];
  availability?: ContextAvailability;
  contextSource?: "tableau-extension" | "mock";
  contextWarning?: string;
  capturedAt: string;
};
