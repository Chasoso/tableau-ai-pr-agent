export type AuthenticatedUser = {
  userId: string;
  email?: string;
  tableauSubject?: string;
  claims?: Record<string, unknown>;
  tokenUse?: string;
};
