# Harness Architecture — Current rc.4 and Future-Safe Direction

## Core definitions

**Agent Harness** = model/runtime launch composition + tools + instructions + inherited Pi resources + policies/workflow.

**Coding Harness** = Agent Harness specialized for repository work, with Git/editor/LSP/tests/terminal/Preview conventions.

## What is implemented in rc.4

Authoritative implementation: `src/harnesses.mjs`.

Current schema is `schemaVersion: 1` and intentionally small:

```ts
interface HarnessV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: 'agent' | 'coding';
  description: string;
  tools: string[] | null;          // null = Pi default/extension tool surface
  appendSystemPrompt: string;
  resourcePolicy: 'inherit-pi';
  updatedAt: string;
}
```

Storage:

- global: Studio app-data `harnesses/`
- project: `<workspace>/.pi/harnesses/`
- project harness wins over a same-ID global custom harness
- built-ins cannot be overwritten/deleted
- corrupt existing manifests are not silently overwritten

Built-ins:

- Coding · Pi Default
- Small Local Coder
- Read-only Review

`Coding · Pi Default + Web` is also a built-in schema-v1 preset. It does not bundle or download a web extension: it provides launch guidance and inherits Pi's normal extension tool surface (`tools: null`). Web search/fetch is available only when the corresponding Pi extension is installed, enabled, trusted, and loaded by the active Pi session. If that resource changes while Pi is running, Studio exposes a restart-required action; the harness remains reusable and Pi-native.

## Why this is useful for local models

Do not claim a harness makes a smaller model intrinsically smarter. The benefit is architectural:

- fewer irrelevant tool schemas
- less irrelevant instruction/context load
- narrower task workflow
- deterministic repo/test/LSP feedback
- reusable project knowledge through Pi resources
- smaller, staged verification loops

This reduces orchestration/context burden and can make smaller local models more reliable on bounded tasks.

## Future schema direction — NOT implemented in rc.4

Prime/RLM research suggests these future concepts. Preserve room for them, but do not enable behavior in rc.4:

```ts
type ExecutionStrategy = 'native' | 'minimal' | 'kernel' | 'hybrid';
type WorkingMemoryMode = 'none' | 'session' | 'persistent';
type LearningMode = 'off' | 'suggest' | 'sandbox-auto';
type ResourcePolicy = 'inherit-pi' | 'fixed' | 'task-adaptive';

interface HarnessV2Draft extends HarnessV1 {
  executionStrategy?: ExecutionStrategy;
  workingMemory?: {
    mode: WorkingMemoryMode;
    maxRamMb?: number;
    maxDiskMb?: number;
    snapshotPolicy?: 'manual' | 'periodic' | 'on-settle';
  };
  learning?: {
    mode: LearningMode;
    requireHumanApproval?: boolean;
  };
  resourcePolicy?: ResourcePolicy;
  resourceRefs?: {
    skills?: string[];
    extensions?: string[];
    prompts?: string[];
    packages?: string[];
    mcpServers?: string[];
    mcpTools?: string[];
  };
  verification?: {
    commands?: string[];
    runLspDiagnostics?: boolean;
    runTargetedTests?: boolean;
  };
}
```

This is design input only. Migration should be additive and backward-compatible.

## Future execution strategies

### Native

Pi receives its normal/native tool surface and resources.

### Minimal

Pi receives a small task-specific tool allowlist plus concise workflow guidance. This is the near-term strategy already represented by `Small Local Coder`.

### Kernel / RLM

Future experimental mode: model operates through a persistent programmable working-memory/kernel layer. Large data can stay outside the model context and be queried in small slices.

### Hybrid

Future experimental mode: keep high-value audited native operations (for example edit/bash) while using a kernel for large data, indexing or transformations.

Do not make Kernel/Hybrid the default without benchmark evidence on real coding tasks.

## Future learning model

Sessions may discover useful operating patterns. Harnesses preserve the reusable configuration, while Skills/AGENTS.md preserve durable knowledge.

Preferred flow:

```text
session experience
→ proposed reusable lesson/resource change
→ evidence/benchmark/review
→ user accepts/edits/rejects
→ versioned harness/skill update
```

Avoid silent self-modification. The Prime transcript explicitly highlights reward-hacking risk when a refinement loop reinforces shortcuts that satisfy the metric rather than intent.
