export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api",
  useMockTableau: import.meta.env.VITE_USE_MOCK_TABLEAU === "true",
  authRequired: import.meta.env.VITE_AUTH_REQUIRED === "true",
  cognito: {
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "",
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
    region: import.meta.env.VITE_COGNITO_REGION ?? "",
    domain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
    redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI ?? "",
    logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI ?? "",
  },
  appVersion: "0.1.0",
};
