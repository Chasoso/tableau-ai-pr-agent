export type AuthSession = {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  email?: string;
  nickname?: string;
};
