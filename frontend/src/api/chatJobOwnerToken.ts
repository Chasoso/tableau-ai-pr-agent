const storageKey = "tableau-ai-pr-agent.job.owner-token";
const legacyStorageKey = "tableau-chat.job.owner-token";

export function loadChatJobOwnerToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return (
    window.localStorage.getItem(storageKey) ||
    window.localStorage.getItem(legacyStorageKey)
  );
}

export function storeChatJobOwnerToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, token);
  window.localStorage.setItem(legacyStorageKey, token);
}

export function clearChatJobOwnerToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(storageKey);
  window.localStorage.removeItem(legacyStorageKey);
}
