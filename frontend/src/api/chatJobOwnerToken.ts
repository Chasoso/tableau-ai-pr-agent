const storageKey = "tableau-chat.job.owner-token";

export function loadChatJobOwnerToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(storageKey);
}

export function storeChatJobOwnerToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, token);
}

export function clearChatJobOwnerToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(storageKey);
}
