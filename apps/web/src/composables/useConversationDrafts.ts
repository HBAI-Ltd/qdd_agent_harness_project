import { computed, ref, watch, type Ref } from "vue";
import { composeMessage, type MarkdownAttachment } from "../utils/attachmentMarkdown.ts";

interface DraftContents {
  text: string;
  attachments: MarkdownAttachment[];
}

interface Submission {
  key: string;
  gateway: string;
  sessionId: string | null;
  intent: number;
  epoch: number;
  revision: number;
  text: string;
  attachments: MarkdownAttachment[];
  attachmentRevision: number;
}

export function useConversationDrafts(
  gatewayUrl: Ref<string>,
  activeSessionId: Ref<string | null>,
  send: (text: string) => Promise<boolean>,
) {
  const draft = ref("");
  const attachments = ref<MarkdownAttachment[]>([]);
  const saved = new Map<string, DraftContents>();
  const revisions = new Map<string, number>();
  const attachmentRevisions = new Map<string, number>();
  const conversions = ref(new Map<string, number>());
  const conversionJobs = new Set<{ key: string; epoch: number }>();
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
  const currentDraftKey = ref(currentKey);
  const convertingAttachments = computed(() => (conversions.value.get(currentDraftKey.value) ?? 0) > 0);

  function setDraft(text: string) {
    updatingDraft = true;
    draft.value = text;
    updatingDraft = false;
  }

  function setAttachments(items: MarkdownAttachment[]) {
    updatingDraft = true;
    attachments.value = [...items];
    updatingDraft = false;
  }

  function snapshot(): DraftContents {
    return { text: draft.value, attachments: [...attachments.value] };
  }

  watch(draft, () => {
    if (!updatingDraft) revisions.set(currentKey, (revisions.get(currentKey) ?? 0) + 1);
  }, { flush: "sync" });
  watch(attachments, () => {
    if (!updatingDraft) attachmentRevisions.set(currentKey, (attachmentRevisions.get(currentKey) ?? 0) + 1);
  }, { deep: true, flush: "sync" });

  watch([gatewayUrl, activeSessionId], ([gateway, id], [previousGateway, previousId]) => {
    const nextKey = keyFor(gateway, id);
    if (nextKey === currentKey) return;
    const previousKey = currentKey;
    const previous = snapshot();
    saved.set(previousKey, previous);

    // Explicit selection changes intent before changing the id. A matching
    // null-to-id transition therefore belongs to the pending first message.
    const creation = id !== null && previousId === null && gateway === previousGateway
      ? [...submissions].find((submission) => submission.sessionId === null
        && submission.key === previousKey && submission.gateway === gateway
        && submission.intent === intent && submission.epoch === epoch)
      : undefined;
    currentKey = nextKey;
    currentDraftKey.value = nextKey;
    if (creation) {
      // The composer was cleared on submission. Carry only subsequent edits,
      // and keep failure recovery attached to the newly created conversation.
      revisions.set(nextKey, revisions.get(previousKey) ?? 0);
      revisions.delete(previousKey);
      attachmentRevisions.set(nextKey, attachmentRevisions.get(previousKey) ?? 0);
      attachmentRevisions.delete(previousKey);
      creation.key = nextKey;
      creation.sessionId = id;
      for (const job of conversionJobs) {
        if (job.key === previousKey && job.epoch === epoch) job.key = nextKey;
      }
      const pendingConversions = conversions.value.get(previousKey);
      if (pendingConversions) {
        conversions.value.set(nextKey, (conversions.value.get(nextKey) ?? 0) + pendingConversions);
        conversions.value.delete(previousKey);
      }
      setDraft(previous.text);
      setAttachments(previous.attachments);
      saved.set(nextKey, snapshot());
      saved.delete(previousKey);
    } else {
      setDraft(saved.get(nextKey)?.text ?? "");
      setAttachments(saved.get(nextKey)?.attachments ?? []);
    }
  }, { flush: "sync" });

  function beginSelection() {
    intent++;
  }

  function startNewDraft() {
    saved.set(currentKey, snapshot());
    intent++;
    draftGenerations.set(gatewayUrl.value, ++generation);
    currentKey = keyFor(gatewayUrl.value, null);
    currentDraftKey.value = currentKey;
    setDraft("");
    setAttachments([]);
    saved.delete(currentKey);
  }

  function clear() {
    intent++;
    epoch++;
    saved.clear();
    revisions.clear();
    attachmentRevisions.clear();
    conversions.value.clear();
    conversionJobs.clear();
    submissions.clear();
    draftGenerations.clear();
    draftGenerations.set(gatewayUrl.value, ++generation);
    currentKey = keyFor(gatewayUrl.value, activeSessionId.value);
    currentDraftKey.value = currentKey;
    setDraft("");
    setAttachments([]);
  }

  async function addAttachments(load: () => Promise<MarkdownAttachment[]>): Promise<void> {
    const job = { key: currentKey, epoch };
    conversionJobs.add(job);
    conversions.value.set(job.key, (conversions.value.get(job.key) ?? 0) + 1);
    try {
      const items = await load();
      if (job.epoch !== epoch || !items.length) return;
      const key = job.key;
      if (currentKey === key) attachments.value = [...attachments.value, ...items];
      else {
        const previous = saved.get(key) ?? { text: "", attachments: [] };
        saved.set(key, { ...previous, attachments: [...previous.attachments, ...items] });
        attachmentRevisions.set(key, (attachmentRevisions.get(key) ?? 0) + 1);
      }
    } finally {
      conversionJobs.delete(job);
      if (job.epoch === epoch) {
        const remaining = (conversions.value.get(job.key) ?? 1) - 1;
        if (remaining > 0) conversions.value.set(job.key, remaining);
        else conversions.value.delete(job.key);
      }
    }
  }

  async function submitMessage(): Promise<boolean> {
    if ((!draft.value.trim() && !attachments.value.length) || convertingAttachments.value
      || [...submissions].some((submission) => submission.key === currentKey && submission.epoch === epoch)) {
      return false;
    }
    const message = composeMessage(draft.value, attachments.value);
    const submission: Submission = {
      key: currentKey,
      gateway: gatewayUrl.value,
      sessionId: activeSessionId.value,
      intent,
      epoch,
      revision: revisions.get(currentKey) ?? 0,
      text: draft.value,
      attachments: [...attachments.value],
      attachmentRevision: attachmentRevisions.get(currentKey) ?? 0,
    };
    submissions.add(submission);
    setDraft("");
    setAttachments([]);
    saved.set(submission.key, snapshot());

    function restoreDraft() {
      // A failed request must not replace anything typed after sending, even
      // when the user types and then deletes it or re-enters the same text.
      if (submission.epoch !== epoch) return;
      const restoreText = (revisions.get(submission.key) ?? 0) === submission.revision;
      const restoreAttachments = (attachmentRevisions.get(submission.key) ?? 0) === submission.attachmentRevision;
      if (currentKey === submission.key) {
        if (restoreText && draft.value === "") setDraft(submission.text);
        if (restoreAttachments && !attachments.value.length) setAttachments(submission.attachments);
      } else {
        const contents = saved.get(submission.key);
        if (contents) saved.set(submission.key, {
          text: restoreText && !contents.text ? submission.text : contents.text,
          attachments: restoreAttachments && !contents.attachments.length ? submission.attachments : contents.attachments,
        });
      }
    }

    try {
      const sent = await send(message);
      if (!sent) restoreDraft();
      return sent;
    } catch (cause) {
      restoreDraft();
      throw cause;
    } finally {
      submissions.delete(submission);
    }
  }

  return { draft, attachments, convertingAttachments, addAttachments, submitMessage, beginSelection, startNewDraft, clear };
}
