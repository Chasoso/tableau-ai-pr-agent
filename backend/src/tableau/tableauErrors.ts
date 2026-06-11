export class TableauRequestError extends Error {
  constructor(
    message: string,
    readonly details: {
      operation: string;
      status?: number;
      path?: string;
      tableauErrorCode?: string;
      tableauErrorSummary?: string;
      tableauErrorDetail?: string;
    },
  ) {
    super(message);
    this.name = "TableauRequestError";
  }
}
