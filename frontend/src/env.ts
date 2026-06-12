export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api",
  prActionImagePublicBaseUrl:
    import.meta.env.VITE_PR_ACTION_IMAGE_PUBLIC_BASE_URL ?? "",
  prActionImageObjectKeyPrefix:
    import.meta.env.VITE_PR_ACTION_IMAGE_OBJECT_KEY_PREFIX ?? "action-runs",
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
