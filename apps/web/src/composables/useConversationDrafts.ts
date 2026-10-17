import { ref, watch, type Ref } from "vue";

interface Submission {
  key: string;
  gateway: string;
  sessionId: string | null;
  intent: number;
  epoch: number;
  revision: number;
  text: string;
}

export function useConversationDrafts(
  gatewayUrl: Ref<string>,
  activeSessionId: Ref<string | null>,
  send: (text: string) => Promise<boolean>,
) {
  const draft = ref("");
  const saved = new Map<string, string>();
  const revisions = new Map<string, number>();
  const draftGenerations = new Map<string, number>();
  const submissions = new Set<Submission>();
  let generation = 0;
  let intent = 0;
  let epoch = 0;
  let updatingDraft = false;

  function keyFor(gateway: string, id: string | null): string {
    return JSON.stringify(id === null
      ? [gateway, "draft", draftGenerations.get(gateway) ?? 0]
      : [gateway, "session", id]);
  }

  let currentKey = keyFor(gatewayUrl.value, activeSessionId.value);

  function setDraft(text: string) {
    updatingDraft = true;
    draft.value = text;
    updatingDraft = false;
  }

  watch(draft, () => {
    if (!updatingDraft) revisions.set(currentKey, (revisions.get(currentKey) ?? 0) + 1);
  }, { flush: "sync" });

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
      // The composer was cleared on submission. Carry only subsequent edits,
      // and keep failure recovery attached to the newly created conversation.
      revisions.set(nextKey, revisions.get(previousKey) ?? 0);
      revisions.delete(previousKey);
      creation.key = nextKey;
      creation.sessionId = id;
      setDraft(previousText);
      saved.set(nextKey, draft.value);
      saved.delete(previousKey);
    } else {
      setDraft(saved.get(nextKey) ?? "");
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
    setDraft("");
    saved.delete(currentKey);
  }

  function clear() {
    intent++;
    epoch++;
    saved.clear();
    revisions.clear();
    submissions.clear();
    draftGenerations.clear();
    draftGenerations.set(gatewayUrl.value, ++generation);
    currentKey = keyFor(gatewayUrl.value, activeSessionId.value);
    setDraft("");
  }

  async function submitMessage(): Promise<boolean> {
    if (!draft.value.trim() || [...submissions].some((submission) => submission.key === currentKey && submission.epoch === epoch)) {
      return false;
    }
    const submission: Submission = {
      key: currentKey,
      gateway: gatewayUrl.value,
      sessionId: activeSessionId.value,
      intent,
      epoch,
      revision: revisions.get(currentKey) ?? 0,
      text: draft.value,
    };
    submissions.add(submission);
    setDraft("");
    saved.set(submission.key, "");

    function restoreDraft() {
      // A failed request must not replace anything typed after sending, even
      // when the user types and then deletes it or re-enters the same text.
      if (submission.epoch !== epoch || (revisions.get(submission.key) ?? 0) !== submission.revision) return;
      if (currentKey === submission.key) {
        if (draft.value === "") setDraft(submission.text);
      } else if (saved.get(submission.key) === "") {
        saved.set(submission.key, submission.text);
      }
    }

    try {
      const sent = await send(submission.text);
      if (!sent) restoreDraft();
      return sent;
    } catch (cause) {
      restoreDraft();
      throw cause;
    } finally {
      submissions.delete(submission);
    }
  }

  return { draft, submitMessage, beginSelection, startNewDraft, clear };
}
