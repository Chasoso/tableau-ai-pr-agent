import type { DashboardContext } from "../types/tableau";

type Props = {
  dashboardContext: DashboardContext;
};

export default function DashboardContextPanel({ dashboardContext }: Props) {
  const isMockContext = dashboardContext.contextSource === "mock";

  return (
    <aside className="context-card" aria-label="Dashboard context summary">
      <div className="context-source-row">
        <span
          className={
            isMockContext ? "context-source mock" : "context-source live"
          }
        >
          {isMockContext ? "モック" : "Tableau"}
        </span>
      </div>
      {dashboardContext.contextWarning ? (
        <div className="context-warning">{dashboardContext.contextWarning}</div>
      ) : null}
      <div className="context-row">
        <span>ダッシュボード</span>
        <strong>{dashboardContext.dashboardName}</strong>
      </div>
      <div className="context-row">
        <span>ワークブック</span>
        <strong>{dashboardContext.workbookName ?? "未取得"}</strong>
      </div>
      <div className="context-grid">
        <div>
          <strong>{dashboardContext.worksheets.length}</strong>
          <span>シート</span>
        </div>
        <div>
          <strong>{dashboardContext.filters.length}</strong>
          <span>フィルター</span>
        </div>
        <div>
          <strong>{dashboardContext.parameters.length}</strong>
          <span>パラメーター</span>
        </div>
      </div>
    </aside>
  );
}
