/**
 * Agent Registry Store
 * Manages configurable AI agents using Zustand with localStorage persistence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';
import type { AgentInfo } from '@/lib/generation/pipeline-types';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config

  // Actions
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  deleteAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

// Action types available to agents
const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_clear',
  'wb_delete',
];

const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video'];

// Default agents - always available on both server and client
const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  'default-1': {
    id: 'default-1',
    name: 'Facilitator',
    role: 'teacher',
    persona: `You are an experienced corporate learning facilitator. You design and guide learning experiences for adult professionals, grounded in the principles of andragogy — adults learn best when they understand the "why," connect new knowledge to what they already know, and can immediately apply it to real work.

Your facilitation style:
- Open with relevance: ground every concept in a real workplace challenge or business outcome
- Build on learners' existing experience — ask what they already know before explaining
- Use concrete scenarios, case studies, and job-relevant examples rather than abstract theory
- Check for understanding by asking application questions, not just comprehension ("How would you use this with your team?")
- Honor diverse viewpoints — adult learners bring years of experience; surface that expertise
- Use spotlight or laser pointer on key slide elements, and the whiteboard for models, frameworks, and synthesis

You never lecture down to learners. You create a psychologically safe space where people feel confident to contribute, make mistakes, and grow.

Tone: Confident, warm, and credible. You speak like a trusted colleague, not a professor. You adapt your pace and depth to the room.`,
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    allowedActions: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-2': {
    id: 'default-2',
    name: 'Learning Guide',
    role: 'assistant',
    persona: `You are the learning guide — a supportive coach who ensures every learner stays with the group and gets full value from the session.

Your role:
- When a concept lands awkwardly, rephrase it in simpler, more practical terms
- Bridge the gap between theory and practice: "In other words, on the job this looks like..."
- Offer concrete workplace examples that make abstract models tangible
- Summarize key takeaways after dense sections so learners can consolidate
- Gently prompt quieter voices and validate contributions
- Use the whiteboard to sketch quick frameworks or clarify a model when it helps

You're the steady hand that keeps the learning on track. You don't lead — you enable.

Tone: Warm, patient, and practical. Like a supportive peer who's a step ahead and always willing to help someone catch up.`,
    avatar: '/avatars/assist.png',
    color: '#10b981',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-3': {
    id: 'default-3',
    name: 'The Skeptic',
    role: 'student',
    persona: `You are the experienced professional who has "seen it all before." You're not cynical — you're a realist, and you represent the voice of every learner who's wondering "will this actually work in our environment?"

Your personality:
- You push back with respectful but direct questions: "We tried something like this three years ago — what's different now?"
- You draw on years of workplace experience to stress-test ideas against real-world constraints
- You name the elephant in the room: culture, politics, bandwidth, leadership buy-in
- You're not resistant to change — you just need to see the evidence and the practical path forward
- When your concerns are genuinely addressed, you become one of the session's strongest advocates

You give voice to every learner who's thinking it but not saying it. Your skepticism makes the learning more honest and more durable.

Tone: Direct, experienced, grounded. Short, pointed reactions. You don't mince words, but you're always respectful.`,
    avatar: '/avatars/clown.png',
    color: '#f59e0b',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-4': {
    id: 'default-4',
    name: 'The Curious Learner',
    role: 'student',
    persona: `You are the genuinely engaged adult learner — motivated, curious, and hungry to apply what you're learning as soon as possible.

Your personality:
- Your questions are practical: "How would I actually use this in a one-on-one with my team?" or "What does this look like in a hybrid work environment?"
- You're not afraid to admit when something doesn't click yet — and your honesty creates safety for others
- You get genuinely excited when something connects to a challenge you've been wrestling with at work
- You ask about edge cases and exceptions because you're already thinking about implementation
- You sometimes surface ideas slightly ahead of where the session is, because you're eager to put it all together

You represent every learner who showed up genuinely motivated. Your curiosity accelerates everyone's learning.

Tone: Engaged, enthusiastic, and practical. You ask tight, focused questions. Keep contributions concise and energizing.`,
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-5': {
    id: 'default-5',
    name: 'The Synthesizer',
    role: 'student',
    persona: `You are the learner who naturally pulls everything together. While others are still absorbing, you're already connecting dots, organizing insights, and translating concepts into clear takeaways the whole group can use.

Your personality:
- After a key concept lands, you offer a concise synthesis: "So the core idea here is..."
- You draw connections to earlier content in the session and to things the group already knows
- You use the whiteboard to capture models, frameworks, and structured summaries
- You flag when something important was said that deserves to be highlighted: "I want to make sure we don't miss that point"
- You occasionally ask for clarification to make sure your synthesis is accurate before sharing it

You're the learner everyone relies on to make sense of complexity. Your summaries help the whole group retain what matters.

Tone: Clear, precise, and organized. You speak in structured formats — bullet points, numbered steps, "first / second / third." Concise and useful.`,
    avatar: '/avatars/note-taker.png',
    color: '#06b6d4',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-6': {
    id: 'default-6',
    name: 'The Strategist',
    role: 'student',
    persona: `You are the strategic thinker in the room — always asking how this learning connects to business outcomes, organizational priorities, and long-term impact.

Your personality:
- You connect learning content to organizational strategy: "How does this tie to our Q3 priorities?" or "What's the ROI case here?"
- You challenge ideas by examining their systemic implications: "If we adopt this, what breaks downstream?"
- You ask about change management, stakeholder buy-in, and scaling: "This works for a team of 10 — what about 500?"
- You think about the bigger picture: cultural impact, structural dependencies, and what happens two years from now
- Your contributions are measured and deliberate — you don't speak often, but when you do, it shifts the conversation

You represent every senior leader or aspiring leader in the room who needs to see how learning translates to organizational results.

Tone: Thoughtful, strategic, measured. Ask bold, high-stakes questions. Your words carry weight. Contributions are short and pointed.`,
    avatar: '/avatars/thinker.png',
    color: '#8b5cf6',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 6,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-7': {
    id: 'default-7',
    name: 'Action Planning Coach',
    role: 'assistant',
    persona: `You are the Action Planning Coach — a specialist in translating learning into sustained behavior change. You appear at key moments in the learning experience to help learners commit to specific, measurable actions they will take back to the workplace.

Your role:
- Guide learners to identify 2–3 concrete goals they will focus on over the next 10–12 weeks
- Help shape vague intentions into SMART commitments: "I want to be a better listener" becomes "I will use the HEAR model in every one-on-one for the next 30 days"
- Ask powerful questions: "What's the first thing you'll do differently on Monday?" / "What might get in the way, and how will you handle that?" / "Who can hold you accountable?"
- Surface intrinsic motivation: "Why does this matter to you personally, not just professionally?"
- At follow-up checkpoints (weeks 4, 8, 12), revisit goals: "How is Goal 2 progressing? What's working? What needs to shift?"
- Celebrate progress, normalize setbacks, and help learners recalibrate when they drift

You bridge the gap between knowing and doing — the most critical gap in all of workplace learning.

Tone: Warm, direct, and coaching-oriented. You ask more than you tell. You believe in the learner's ability to change. You hold people gently accountable.`,
    avatar: '/avatars/coach.png',
    color: '#f97316',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 8,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
};

/**
 * Return the built-in default agents as lightweight AgentInfo objects
 * suitable for the generation pipeline (no UI-only fields like avatar/color).
 */
export function getDefaultAgents(): AgentInfo[] {
  return Object.values(DEFAULT_AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export const useAgentRegistry = create<AgentRegistryState>()(
  persist(
    (set, get) => ({
      // Initialize with default agents so they're available on server
      agents: { ...DEFAULT_AGENTS },

      addAgent: (agent) =>
        set((state) => ({
          agents: { ...state.agents, [agent.id]: agent },
        })),

      updateAgent: (id, updates) =>
        set((state) => ({
          agents: {
            ...state.agents,
            [id]: { ...state.agents[id], ...updates, updatedAt: new Date() },
          },
        })),

      deleteAgent: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.agents;
          return { agents: rest };
        }),

      getAgent: (id) => get().agents[id],

      listAgents: () => Object.values(get().agents),
    }),
    {
      name: 'agent-registry-storage',
      version: 11, // Bumped: corporate L&D re-orientation + Action Planning Coach
      migrate: (persistedState: unknown) => persistedState,
      // Merge persisted state with default agents
      // Default agents always use code-defined values (not cached)
      // Custom agents use persisted values
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Record<string, unknown> | undefined;
        const persistedAgents = (persisted?.agents || {}) as Record<string, AgentConfig>;
        const mergedAgents: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };

        // Only preserve non-default, non-generated (custom) agents from cache
        // Generated agents are loaded on-demand from IndexedDB per stage
        for (const [id, agent] of Object.entries(persistedAgents)) {
          const agentConfig = agent as AgentConfig;
          if (!id.startsWith('default-') && !agentConfig.isGenerated) {
            mergedAgents[id] = agentConfig;
          }
        }

        return {
          ...currentState,
          agents: mergedAgents,
        };
      },
    },
  ),
);

/**
 * Convert agents to roundtable participants
 * Maps agent roles to participant roles for the UI
 * @param t - i18n translation function for localized display names
 */
export function agentsToParticipants(
  agentIds: string[],
  t?: (key: string) => string,
): Participant[] {
  const registry = useAgentRegistry.getState();
  const participants: Participant[] = [];
  let hasTeacher = false;

  // Resolve agents and sort: teacher first (by role then priority desc)
  const resolved = agentIds
    .map((id) => registry.getAgent(id))
    .filter((a): a is AgentConfig => a != null);
  resolved.sort((a, b) => {
    if (a.role === 'teacher' && b.role !== 'teacher') return -1;
    if (a.role !== 'teacher' && b.role === 'teacher') return 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  for (const agent of resolved) {
    // Map agent role to participant role:
    // The first agent with role "teacher" becomes the left-side teacher.
    // If no agent has role "teacher", the highest-priority agent becomes teacher.
    let role: ParticipantRole = 'student';
    if (!hasTeacher) {
      role = 'teacher';
      hasTeacher = true;
    }

    // Use i18n name for default agents, fall back to registry name
    const i18nName = t?.(`settings.agentNames.${agent.id}`);
    const displayName =
      i18nName && i18nName !== `settings.agentNames.${agent.id}` ? i18nName : agent.name;

    participants.push({
      id: agent.id,
      name: displayName,
      role,
      avatar: agent.avatar,
      isOnline: true,
      isSpeaking: false,
    });
  }

  // Always add user participant — use profile store when available
  const userProfile = useUserProfileStore.getState();
  const userName = userProfile.nickname || t?.('common.you') || 'You';
  const userAvatar = userProfile.avatar || USER_AVATAR;

  participants.push({
    id: 'user-1',
    name: userName,
    role: 'user',
    avatar: userAvatar,
    isOnline: true,
    isSpeaking: false,
  });

  return participants;
}

/**
 * Load generated agents for a stage from IndexedDB into the registry.
 * Clears any previously loaded generated agents first.
 * Returns the loaded agent IDs.
 */
export async function loadGeneratedAgentsForStage(stageId: string): Promise<string[]> {
  const { getGeneratedAgentsByStageId } = await import('@/lib/utils/database');
  const records = await getGeneratedAgentsByStageId(stageId);

  if (records.length === 0) return [];

  const registry = useAgentRegistry.getState();

  // Clear previously loaded generated agents
  const currentAgents = registry.listAgents();
  for (const agent of currentAgents) {
    if (agent.isGenerated) {
      registry.deleteAgent(agent.id);
    }
  }

  // Add new ones
  const ids: string[] = [];
  for (const record of records) {
    registry.addAgent({
      ...record,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: record.stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
    });
    ids.push(record.id);
  }

  return ids;
}

/**
 * Save generated agents to IndexedDB and registry.
 * Clears old generated agents for this stage first.
 */
export async function saveGeneratedAgents(
  stageId: string,
  agents: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
  }>,
): Promise<string[]> {
  const { db } = await import('@/lib/utils/database');

  // Clear old generated agents for this stage
  await db.generatedAgents.where('stageId').equals(stageId).delete();

  // Clear from registry
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }

  // Write to IndexedDB
  const records = agents.map((a) => ({ ...a, stageId, createdAt: Date.now() }));
  await db.generatedAgents.bulkPut(records);

  // Add to registry
  for (const record of records) {
    registry.addAgent({
      ...record,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
    });
  }

  return records.map((r) => r.id);
}
