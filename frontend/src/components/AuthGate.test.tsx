import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AuthGate from "./AuthGate";
import type { AuthSession } from "../types/auth";

const mocks = vi.hoisted(() => ({
  getStoredSession: vi.fn(),
  openLoginPopupWindow: vi.fn(),
  storeSession: vi.fn(),
  startPopupAuth: vi.fn(),
  getPopupAuthStatus: vi.fn(),
}));

vi.mock("../auth/cognitoAuth", () => ({
  getStoredSession: mocks.getStoredSession,
  openLoginPopupWindow: mocks.openLoginPopupWindow,
  storeSession: mocks.storeSession,
}));

vi.mock("../api/authApi", () => ({
  startPopupAuth: mocks.startPopupAuth,
  getPopupAuthStatus: mocks.getPopupAuthStatus,
}));

const popupMock = {
  closed: false,
  close: vi.fn(),
  location: {
    replace: vi.fn(),
  },
} as unknown as Window;

const storedSession: AuthSession = {
  accessToken: "cached-access",
  idToken: "cached-id",
  expiresAt: Date.now() + 60_000,
  email: "cached@example.com",
  nickname: "cached-user",
};

const signedInSession: AuthSession = {
  accessToken: "fresh-access",
  idToken: "fresh-id",
  expiresAt: Date.now() + 60_000,
  email: "fresh@example.com",
  nickname: "fresh-user",
};

function renderGate() {
  return render(
    <AuthGate>
      {(state) => (
        <div>
          <button onClick={() => void state.startSignIn()}>Sign in</button>
          <div data-testid="session">{state.session?.email ?? ""}</div>
          <div data-testid="error">{state.error ?? ""}</div>
          <div data-testid="loading">{String(state.isLoading)}</div>
          <div data-testid="signing">{String(state.isSigningIn)}</div>
        </div>
      )}
    </AuthGate>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.pushState({}, "", "/");
});

describe("AuthGate", () => {
  it("hydrates an existing session from storage", async () => {
    mocks.getStoredSession.mockReturnValue(storedSession);

    renderGate();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("session")).toHaveTextContent(
      "cached@example.com",
    );
  });

  it("starts popup auth and stores the completed session", async () => {
    const user = userEvent.setup();
    mocks.getStoredSession.mockReturnValue(null);
    mocks.openLoginPopupWindow.mockReturnValue(popupMock);
    mocks.startPopupAuth.mockResolvedValue({
      transactionId: "txn-1",
      pollToken: "poll-1",
      authorizationUrl: "https://example.com/login",
      expiresAt: "2026-06-05T00:00:00.000Z",
    });
    mocks.getPopupAuthStatus.mockResolvedValue({
      status: "completed",
      session: signedInSession,
    });

    window.history.pushState({}, "", "/dashboard?tab=summary");
    renderGate();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mocks.storeSession).toHaveBeenCalledWith(signedInSession),
    );
    expect(mocks.startPopupAuth).toHaveBeenCalledWith({
      redirectAfter: "/dashboard?tab=summary",
    });
    expect(popupMock.location.replace).toHaveBeenCalledWith(
      "https://example.com/login",
    );
    expect(screen.getByTestId("session")).toHaveTextContent(
      "fresh@example.com",
    );
    expect(screen.getByTestId("error")).toHaveTextContent("");
    expect(screen.getByTestId("signing")).toHaveTextContent("false");
  });

  it("surfaces an error when popup auth startup fails", async () => {
    const user = userEvent.setup();
    mocks.getStoredSession.mockReturnValue(null);
    mocks.openLoginPopupWindow.mockReturnValue(popupMock);
    mocks.startPopupAuth.mockRejectedValue(new Error("startup failed"));

    renderGate();

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("startup failed"),
    );
    expect(popupMock.close).toHaveBeenCalled();
    expect(screen.getByTestId("signing")).toHaveTextContent("false");
  });
});
