export type AuthSession = {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  userId?: string;
  email?: string;
  nickname?: string;
};
