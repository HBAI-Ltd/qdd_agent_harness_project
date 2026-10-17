interface Conversation {
  id: string;
  updatedAt: string;
}

interface ConversationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CONVERSATION_STORAGE_PREFIX = "harness-conversation-v1:";
export const CONVERSATION_DRAFT_VALUE = "__draft__";

/** Gateway keys must already be normalized and contain no credentials. */
export function createConversationSelection(storage?: ConversationStorage) {
  // undefined is an uninitialized choice; null is an explicitly chosen draft.
  const remembered = new Map<string, string | null | undefined>();

  function readChoice(gateway: string): string | null | undefined {
    if (remembered.has(gateway)) return remembered.get(gateway);
    let id: string | null | undefined;
    try {
      const saved = storage?.getItem(`${CONVERSATION_STORAGE_PREFIX}${gateway}`);
      if (saved === CONVERSATION_DRAFT_VALUE) id = null;
      else if (saved?.trim()) id = saved;
    } catch {
      // Browser storage may be unavailable; the current conversation still works.
    }
    remembered.set(gateway, id);
    return id;
  }

  function read(gateway: string): string | null {
    return readChoice(gateway) ?? null;
  }

  function remember(gateway: string, id: string | null) {
    remembered.set(gateway, id);
    try { storage?.setItem(`${CONVERSATION_STORAGE_PREFIX}${gateway}`, id ?? CONVERSATION_DRAFT_VALUE); } catch { /* Keep the in-memory choice. */ }
  }

  function choose(gateway: string, sessions: readonly Conversation[], currentId: string | null = null): string | null {
    const preferred = currentId ?? readChoice(gateway);
    if (preferred === null) return null;
    const existing = sessions.find((session) => session.id === preferred);
    const newest = existing ?? sessions.reduce<Conversation | undefined>((latest, session) =>
      !latest || session.updatedAt > latest.updatedAt ? session : latest, undefined);
    const id = newest?.id ?? null;
    if (id) remember(gateway, id);
    else {
      remembered.set(gateway, undefined);
      try { storage?.setItem(`${CONVERSATION_STORAGE_PREFIX}${gateway}`, ""); } catch { /* Keep the in-memory choice. */ }
    }
    return id;
  }

  return { read, remember, choose };
}
