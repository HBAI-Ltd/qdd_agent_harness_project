import { ref, watch, type Ref } from "vue";

interface Submission {
  key: string;
  gateway: string;
  sessionId: string | null;
  intent: number;
  epoch: number;
  text: string;
}

export function useConversationDrafts(
  gatewayUrl: Ref<string>,
  activeSessionId: Ref<string | null>,
  send: (text: string) => Promise<boolean>,
) {
  const draft = ref("");
  const saved = new Map<string, string>();
  const draftGenerations = new Map<string, number>();
  const submissions = new Set<Submission>();
  let generation = 0;
  let intent = 0;
  let epoch = 0;

  function keyFor(gateway: string, id: string | null): string {
    return JSON.stringify(id === null
      ? [gateway, "draft", draftGenerations.get(gateway) ?? 0]
      : [gateway, "session", id]);
  }

  let currentKey = keyFor(gatewayUrl.value, activeSessionId.value);

  watch([gatewayUrl, activeSessionId], ([gateway, id], [previousGateway, previousId]) => {
    const nextKey = keyFor(gateway, id);
    if (nextKey === currentKey) return;
    const previousKey = currentKey;
    const previousText = draft.value;
    saved.set(previousKey, previousText);

    // Explicit selection changes intent before changing the id. A matching
    // null-to-id transition therefore belongs to the pending first message.
    const creation = id !== null && previousId === null && gateway === previousGateway
      ? [...submissions].find((submission) => submission.sessionId === null
        && submission.key === previousKey && submission.gateway === gateway
        && submission.intent === intent && submission.epoch === epoch)
      : undefined;
    currentKey = nextKey;
    if (creation) {
      draft.value = previousText === creation.text ? "" : previousText;
      saved.set(nextKey, draft.value);
      saved.delete(previousKey);
    } else {
      draft.value = saved.get(nextKey) ?? "";
    }
  }, { flush: "sync" });

  function beginSelection() {
    intent++;
  }

  function startNewDraft() {
    saved.set(currentKey, draft.value);
    intent++;
    draftGenerations.set(gatewayUrl.value, ++generation);
    currentKey = keyFor(gatewayUrl.value, null);
    draft.value = "";
    saved.delete(currentKey);
  }

  function clear() {
    intent++;
    epoch++;
    saved.clear();
    submissions.clear();
    draftGenerations.clear();
    draftGenerations.set(gatewayUrl.value, ++generation);
    currentKey = keyFor(gatewayUrl.value, activeSessionId.value);
    draft.value = "";
  }

  async function submitMessage(): Promise<boolean> {
    const submission: Submission = {
      key: currentKey,
      gateway: gatewayUrl.value,
      sessionId: activeSessionId.value,
      intent,
      epoch,
      text: draft.value,
    };
    submissions.add(submission);
    try {
      const sent = await send(submission.text);
      if (sent && submission.epoch === epoch) {
        if (currentKey === submission.key) {
          if (draft.value === submission.text) draft.value = "";
        } else if (saved.get(submission.key) === submission.text) {
          saved.delete(submission.key);
        }
      }
      return sent;
    } finally {
      submissions.delete(submission);
    }
  }

  return { draft, submitMessage, beginSelection, startNewDraft, clear };
}
