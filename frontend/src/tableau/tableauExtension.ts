import { env } from "../env";
import type { DashboardContext } from "../types/tableau";
import {
  createMockDashboardContext,
  getDashboardContext,
} from "./dashboardContext";

type TableauExtensionsGlobal = {
  extensions?: {
    initializeAsync: () => Promise<void>;
    workbook?: unknown;
    dashboardContent?: {
      dashboard?: unknown;
    };
  };
};

declare global {
  interface Window {
    tableau?: TableauExtensionsGlobal;
  }
}

export async function initializeTableauExtension(): Promise<DashboardContext> {
  if (env.useMockTableau) {
    return createMockDashboardContext(
      "VITE_USE_MOCK_TABLEAU=true のため、モック情報を使用しています。",
    );
  }

  const tableau = window.tableau?.extensions;
  if (!tableau?.initializeAsync) {
    return createMockDashboardContext(
      "ブラウザー内でTableau Extensions APIを利用できなかったため、モック情報を使用しています。",
    );
  }

  try {
    await tableau.initializeAsync();
    const dashboard = tableau.dashboardContent?.dashboard;
    if (!dashboard) {
      return createMockDashboardContext(
        "Tableau Extensions APIは初期化されましたが、アクティブなダッシュボードを取得できませんでした。",
      );
    }

    return getDashboardContext(dashboard, {
      workbook: tableau.workbook,
      referrer: document.referrer,
    });
  } catch (error) {
    console.warn(
      "Falling back to mock Tableau context. Tableau initialization failed.",
      error,
    );
    return createMockDashboardContext(
      "Tableau Extensions APIの初期化に失敗したため、モック情報を使用しています。",
    );
  }
}
