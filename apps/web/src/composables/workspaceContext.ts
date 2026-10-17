import { inject, type InjectionKey, type Ref } from "vue";
import type { useWorkspace } from "./useWorkspace";
import type { useComposer } from "./useComposer";
import type { Overview, PendingItem, Skill } from "@qdd/shared";
import type { GatewayResource } from "./useGatewayResource";

export type WorkspaceView = "overview" | "chat" | "tasks" | "settings" | "schedules" | "skills" | "connectors";

export interface WorkspaceContext {
  workspace: ReturnType<typeof useWorkspace>;
  overview: GatewayResource<Overview>;
  pending: GatewayResource<PendingItem[]>;
  draft: Ref<string>;
  submitMessage: () => Promise<boolean>;
  composer: ReturnType<typeof useComposer>;
  notify: (message: string) => void;
  navigation: {
    openConversation: () => Promise<void>;
    openSession: (id: string) => Promise<void>;
    newConversation: () => Promise<void>;
    runSkill: (skill: Skill) => Promise<void>;
    openPage: (slug: string) => Promise<void>;
    openView: (view: WorkspaceView) => Promise<void>;
    editPage: (slug: string) => Promise<boolean>;
  };
}

export const WORKSPACE_CONTEXT: InjectionKey<WorkspaceContext> = Symbol("workspace");

export function useWorkspaceContext(): WorkspaceContext {
  const context = inject(WORKSPACE_CONTEXT);
  if (!context) throw new Error("Workspace views require the workspace layout.");
  return context;
}
