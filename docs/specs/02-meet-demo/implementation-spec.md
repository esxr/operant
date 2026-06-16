<!-- #core -->
<!-- #google_meet_screen_share -->
# Implementation Specification: Google Meet Live Demo Channel

**Version:** 1.0  
**Date:** 2026-06-06  
**Based on:** Intent v1.0, HLD v1.0, ADR-Lite (ADR-001 through ADR-007)

---

## 1. State Machine Extensions

### 1.1 New States

| State | Phase Group | Description |
|-------|------------|-------------|
| `demo_setup` | demo | Creating Meet space, launching bot browser, generating walkthrough plan |
| `demo_calling` | demo | Outbound Retell call in progress — telling user to join Meet |
| `demo_active` | demo | Bot is in Meet, sharing screen, narrating, listening for commands |
| `demo_feedback` | demo | Walkthrough complete, voice agent capturing structured verdict |

### 1.2 New Transitions

| # | From | To | Trigger | Guards | Side Effects |
|---|------|----|---------|--------|--------------|
| T22 | `audit` | `demo_setup` | `AUDIT_PASSED` | Audit completed without revisions | `CREATE_DEMO` |
| T23 | `demo_setup` | `demo_calling` | `DEMO_READY` | Meet created, bot joined, walkthrough plan generated | `TRIGGER_DEMO_INVITE_CALL` |
| T24 | `demo_calling` | `demo_active` | `USER_JOINED_MEET` | Demo invite call completed | `START_WALKTHROUGH` |
| T25 | `demo_active` | `demo_feedback` | `WALKTHROUGH_COMPLETE` | Walkthrough finished or user ended demo | `CAPTURE_FEEDBACK` |
| T26 | `demo_feedback` | `confirmation` | `DEMO_APPROVED` | User satisfied | `TRIGGER_CONFIRMATION_CALL` |
| T27 | `demo_feedback` | `dev` | `DEMO_REJECTED` | User rejected with pain points | `WRITE_DEMO_REVISION`, `LAUNCH_AGENT` (dev) |
| T28 | `demo_calling` | `confirmation` | `DEMO_SKIPPED` | User declined demo on phone | `TEARDOWN_DEMO`, `TRIGGER_CONFIRMATION_CALL` |
| T29 | `demo_setup` | `confirmation` | `DEMO_FAILED` | Meet creation, bot launch, or audio setup failed | `TEARDOWN_DEMO`, `TRIGGER_CONFIRMATION_CALL` |

### 1.3 Updated Phase Map

```typescript
export type Phase = "idle" | "triage" | "sdlc" | "dev" | "audit" | "demo" | "confirmation";

// stateToPhase additions:
case "demo_setup":
case "demo_calling":
case "demo_active":
case "demo_feedback":
  return "demo";
```

### 1.4 New FSMEvent Types

```typescript
export type FSMEvent =
  // ... existing events ...
  | "DEMO_READY"
  | "USER_JOINED_MEET"
  | "WALKTHROUGH_COMPLETE"
  | "DEMO_APPROVED"
  | "DEMO_REJECTED"
  | "DEMO_SKIPPED"
  | "DEMO_FAILED";
```

### 1.5 New Side Effect Types

```typescript
export type SideEffect =
  // ... existing side effects ...
  | { type: "CREATE_DEMO"; specDir: string }
  | { type: "TRIGGER_DEMO_INVITE_CALL"; specDir: string; meetUrl: string; meetCode: string }
  | { type: "START_WALKTHROUGH"; specDir: string }
  | { type: "CAPTURE_FEEDBACK" }
  | { type: "WRITE_DEMO_REVISION"; specDir: string; painPoints: string[] }
  | { type: "TEARDOWN_DEMO" };
```

### 1.6 Phase Inference Update

Add to `inferState()` algorithm, between audit and confirmation checks:

```
// After checking for audit state:
// Check for demo state:
d. spec/<name>/.demo/ exists:
   i.   .demo/walkthrough.json exists AND .demo/meet.json exists AND
        .demo/feedback.json does NOT exist → "demo_active" (or "demo_setup" if bot not joined)
   ii.  .demo/feedback.json exists with decision="approved" → "confirmation"
   iii. .demo/feedback.json exists with decision="rejected" → "dev" (revision pending)
```

---

## 2. Module Interfaces

### 2.1 Module: `demo/meet.ts` (NEW)

**Responsibility:** Google Meet API client. Creates meeting spaces, retrieves join URLs, manages OAuth2 tokens.

**Public Interface:**

```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeetSpace {
  /** Google Meet space name (resource ID) */
  name: string;
  /** User-facing join URL: https://meet.google.com/abc-defg-hij */
  meetingUri: string;
  /** Meeting code: abc-defg-hij */
  meetingCode: string;
  /** Space configuration */
  config: {
    accessType: "OPEN" | "TRUSTED" | "RESTRICTED";
    entryPointAccess: "ALL" | "CREATOR_APP_ONLY";
  };
}

export interface MeetConfig {
  /** Path to Google OAuth2 credentials JSON (service account or OAuth client) */
  credentialsPath?: string;
  /** Or provide tokens directly */
  accessToken?: string;
  /** OAuth2 scopes needed */
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Initialize the Meet API client with OAuth2 credentials.
 * Must be called before any other function.
 *
 * Credentials are resolved in order:
 * 1. GOOGLE_MEET_CREDENTIALS env var (path to JSON)
 * 2. config.credentialsPath
 * 3. ~/.config/gcloud/application_default_credentials.json
 *
 * @param config - Optional configuration overrides
 */
export function initialize(config?: MeetConfig): Promise<void>;

/**
 * Create a new Google Meet space.
 * POST https://meet.googleapis.com/v2/spaces
 *
 * The space is created with OPEN access (no waiting room)
 * so the bot can join without approval.
 *
 * @returns MeetSpace with meetingUri and meetingCode
 */
export function createSpace(): Promise<MeetSpace>;

/**
 * End an active meeting space (best-effort cleanup).
 * POST https://meet.googleapis.com/v2/spaces/{name}:endActiveConference
 *
 * @param spaceName - The space resource name from createSpace()
 */
export function endSpace(spaceName: string): Promise<void>;

/**
 * Check if the Meet API is available and credentials are valid.
 * Used for graceful fallback (NFC-4).
 */
export function isAvailable(): Promise<boolean>;
```

**Dependencies:** `googleapis` npm package (or raw HTTPS — consistent with existing `retell.ts` pattern).

**OAuth2 scope:** `https://www.googleapis.com/auth/meetings.space.created`

---

### 2.2 Module: `demo/bot.ts` (NEW)

**Responsibility:** Meet bot lifecycle. Launches Chromium, joins Meet, opens product tab, shares product tab, detects user join, leaves Meet.

**Public Interface:**

```typescript
import type { Browser, Page, BrowserContext } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotConfig {
  /** Google Meet join URL (from meet.ts) */
  meetUrl: string;
  /** Product URL to navigate (default: localhost:3000) */
  productUrl: string;
  /** Bot display name in Meet */
  botName?: string;
  /** Chrome executable path (defaults to bundled Chromium) */
  executablePath?: string;
  /** Virtual display number for Xvfb (Linux only, default: 99) */
  displayNumber?: number;
  /** Audio device IDs (from audio.ts) */
  audioInputDevice?: string;   // virtual mic (TTS writes here)
  audioOutputDevice?: string;  // virtual speaker (STT reads here)
}

export interface BotState {
  status: "initializing" | "joining" | "in_meet" | "sharing" | "active" | "leaving" | "stopped";
  meetPage: Page | null;
  productPage: Page | null;
  participantCount: number;
  sharingActive: boolean;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Launch the Meet bot.
 *
 * 1. Start Xvfb virtual display (Linux) or use native display (macOS)
 * 2. Launch Chromium with flags:
 *    --use-fake-ui-for-media-stream
 *    --use-fake-device-for-media-stream (if audio device configured)
 *    --auto-select-desktop-capture-source="Product Demo"
 *    --disable-features=WebRtcHideLocalIpsWithMdns
 *    --no-first-run --no-default-browser-check
 * 3. Authenticate to Google (pre-seeded cookies or OAuth login flow)
 * 4. Navigate to meetUrl, click "Join" (automate the Meet join flow)
 * 5. Open a new tab with productUrl
 * 6. Share the product tab in the Meet
 *
 * @param config - Bot configuration
 * @returns BotState with page handles
 */
export function launch(config: BotConfig): Promise<BotState>;

/**
 * Get a Playwright Page handle for the product tab.
 * Used by walkthrough.ts to drive navigation.
 */
export function getProductPage(): Page | null;

/**
 * Get a Playwright Page handle for the Meet tab.
 * Used for DOM queries (participant count, chat).
 */
export function getMeetPage(): Page | null;

/**
 * Check if a user (non-bot) has joined the Meet.
 * Inspects the Meet UI DOM for participant count > 1.
 *
 * @returns true if at least one other participant is present
 */
export function hasUserJoined(): Promise<boolean>;

/**
 * Leave the Meet and close the browser.
 * Graceful: clicks "Leave" in Meet UI, then closes Chromium.
 */
export function leave(): Promise<void>;

/**
 * Get current bot state.
 */
export function getState(): BotState;

/**
 * Check if the bot can be launched on this platform.
 * Verifies: Chromium available, display available (Xvfb or native),
 * audio devices configured.
 */
export function isAvailable(): Promise<boolean>;
```

**Dependencies:** `playwright-core`, `node:child_process` (for Xvfb), `demo/audio.ts`

**Chrome Launch Flags (complete list):**

```typescript
const CHROME_FLAGS = [
  // Media permissions — auto-accept camera/mic prompts
  "--use-fake-ui-for-media-stream",

  // Audio device — use virtual audio device for mic input
  // (actual device ID set dynamically from audio.ts)
  "--use-fake-device-for-media-stream",

  // Tab sharing — auto-select the product tab for sharing
  // (title must match; set productPage title to "Product Demo")
  "--auto-select-desktop-capture-source=Product Demo",

  // WebRTC — don't hide local IPs (needed for Meet connectivity)
  "--disable-features=WebRtcHideLocalIpsWithMdns",

  // General
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",

  // Disable infobar warnings
  "--disable-infobars",
];
```

**Meet Join Automation Sequence:**

```
1. Navigate to meetUrl
2. Wait for "Ready to join?" screen
3. Mute camera (click camera toggle if on)
4. Verify mic is on (should use virtual device)
5. Set display name to botName ("Operant Demo")
6. Click "Join now" button
7. Wait for Meet UI to load (connected state)
8. Open new tab → productUrl
9. Set product tab title to "Product Demo" (for auto-select matching)
10. Return to Meet tab
11. Click "Present now" → "A tab" → select "Product Demo" tab
12. Confirm sharing started
```

---

### 2.3 Module: `demo/audio.ts` (NEW)

**Responsibility:** Platform-specific virtual audio routing. Creates virtual audio devices, provides read/write streams for TTS output and STT input.

**Public Interface:**

```typescript
import { Readable, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioConfig {
  /** Audio sample rate (default: 16000 for STT, 24000 for TTS) */
  sampleRate?: number;
  /** Audio channels (default: 1 — mono) */
  channels?: number;
  /** Audio bit depth (default: 16) */
  bitDepth?: number;
  /** Platform override (default: auto-detect) */
  platform?: "linux" | "darwin";
}

export interface AudioRoutes {
  /** The virtual device ID to pass to Chrome as mic input */
  chromeInputDeviceId: string;
  /** The virtual device ID to pass to Chrome as speaker output */
  chromeOutputDeviceId: string;
  /** Writable stream: TTS audio → virtual mic → Chrome → Meet participants hear */
  ttsOutput: Writable;
  /** Readable stream: Meet audio → virtual speaker → this stream → STT processes */
  sttInput: Readable;
}

export type AudioPlatform = "pulseaudio" | "blackhole" | "unsupported";

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Detect the audio platform and check prerequisites.
 *
 * Linux: checks for PulseAudio (`pactl` available)
 * macOS: checks for BlackHole (`BlackHole 2ch` in system audio devices)
 *
 * @returns The detected platform or "unsupported"
 */
export function detectPlatform(): Promise<AudioPlatform>;

/**
 * Initialize virtual audio routing.
 *
 * **Linux (PulseAudio):**
 * 1. Create virtual sink: `pactl load-module module-null-sink sink_name=operantpi_tts`
 * 2. Create virtual source: `pactl load-module module-null-sink sink_name=operantpi_stt`
 * 3. Route TTS → sink monitor → Chrome mic
 * 4. Route Chrome speaker → source → STT
 *
 * **macOS (BlackHole):**
 * 1. Verify BlackHole 2ch is installed
 * 2. Create aggregate device combining BlackHole + default output
 * 3. Route TTS → BlackHole input
 * 4. Route BlackHole output → STT
 *
 * @param config - Audio configuration
 * @returns AudioRoutes with device IDs and read/write streams
 */
export function initialize(config?: AudioConfig): Promise<AudioRoutes>;

/**
 * Tear down virtual audio devices.
 * Unloads PulseAudio modules or removes aggregate devices.
 */
export function teardown(): Promise<void>;

/**
 * Check if audio routing is available on this platform.
 */
export function isAvailable(): Promise<boolean>;

/**
 * Write raw PCM audio data to the TTS output stream.
 * This audio will be heard by Meet participants as the bot's mic.
 *
 * @param pcmData - Raw PCM audio buffer (16-bit, mono, at configured sample rate)
 */
export function writeTtsAudio(pcmData: Buffer): void;

/**
 * Read raw PCM audio data from the STT input stream.
 * This audio comes from Meet participants (the user speaking).
 *
 * @param callback - Called with PCM audio chunks as they arrive
 */
export function onSttAudio(callback: (pcmData: Buffer) => void): void;
```

**Dependencies:** `node:child_process` (for `pactl`, `ffmpeg`), `node:stream`

**PulseAudio Setup Commands (Linux):**

```bash
# Create TTS virtual sink (bot's mic)
pactl load-module module-null-sink sink_name=operantpi_tts sink_properties=device.description="OperantPi-TTS"

# Create STT virtual sink (captures Meet audio)
pactl load-module module-null-sink sink_name=operantpi_stt sink_properties=device.description="OperantPi-STT"

# Chrome uses:
# - operantpi_tts.monitor as microphone input
# - operantpi_stt as speaker output
```

**BlackHole Setup Commands (macOS):**

```bash
# Verify BlackHole is installed
system_profiler SPAudioDataType | grep "BlackHole"

# No additional setup needed — BlackHole 2ch appears as a system audio device
# Chrome is launched with:
# --audio-output-device-id=BlackHoleDevice_UID (for capturing Meet audio)
# Input device set to BlackHole 2ch (for TTS → mic)
```

---

### 2.4 Module: `demo/voice-agent.ts` (NEW)

**Responsibility:** Real-time voice AI pipeline for the in-Meet demo. Handles STT → utterance classification → LLM → TTS, with context from the walkthrough plan and browser state.

**Public Interface:**

```typescript
import type { AudioRoutes } from "./audio.js";
import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceAgentConfig {
  /** Audio routes from audio.ts */
  audioRoutes: AudioRoutes;
  /** Product page handle for browser state context */
  productPage: Page;
  /** Path to walkthrough plan JSON */
  walkthroughPlanPath: string;
  /** Path to implementation spec (for answering questions) */
  implementationSpecPath: string;
  /** Path to all spec files (for deep context) */
  specDir: string;
  /** STT provider config */
  stt: {
    provider: "deepgram";
    apiKey: string;
    model?: string;        // default: "nova-3"
    language?: string;      // default: "en"
  };
  /** TTS provider config */
  tts: {
    provider: "elevenlabs";
    apiKey: string;
    voiceId?: string;       // default: a neutral professional voice
    modelId?: string;       // default: "eleven_turbo_v2_5"
  };
  /** LLM config (Claude) */
  llm: {
    apiKey: string;
    model?: string;         // default: "claude-sonnet-4-6"
  };
}

/** Classification of a user utterance */
export type UtteranceType =
  | "navigation"     // "click settings", "go back", "scroll down"
  | "question"       // "what does this do?", "why is it like that?"
  | "feedback"       // "this looks wrong", "I like this", "expected X"
  | "control"        // "next", "skip", "end demo", "go back to step 2"
  | "approval"       // "looks good", "satisfied", "ship it"
  | "rejection"      // "not right", "needs fixing", "I want changes"
  | "ambient";       // laughter, "hmm", "ok", background noise

export interface UtteranceEvent {
  type: UtteranceType;
  text: string;              // Raw STT text
  confidence: number;        // STT confidence 0-1
  timestamp: string;         // ISO8601
  /** For navigation: parsed command */
  navigationCommand?: {
    action: "click" | "navigate" | "scroll" | "type" | "go_back" | "refresh";
    target?: string;          // CSS selector, URL, or element description
    value?: string;           // For type actions
  };
  /** For feedback: structured feedback */
  feedbackItem?: {
    sentiment: "positive" | "negative" | "neutral";
    relatedFR?: string;       // e.g., "FR-3"
    detail: string;
  };
}

export interface DemoTranscript {
  utterances: UtteranceEvent[];
  summary: string;
  decision: "approved" | "rejected" | "undecided";
  positives: string[];
  painPoints: string[];
  navigationRequests: string[];
}

export interface VoiceAgentState {
  status: "initializing" | "ready" | "speaking" | "listening" | "processing" | "stopped";
  currentStep: number;
  totalSteps: number;
  feedbackBuffer: UtteranceEvent[];
  transcript: UtteranceEvent[];
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Initialize the voice agent pipeline.
 *
 * 1. Connect to Deepgram streaming STT (WebSocket)
 * 2. Initialize ElevenLabs streaming TTS (WebSocket)
 * 3. Load walkthrough plan and implementation spec into LLM context
 * 4. Begin listening on audioRoutes.sttInput
 *
 * @param config - Voice agent configuration
 */
export function initialize(config: VoiceAgentConfig): Promise<void>;

/**
 * Speak a message through the bot's mic (TTS → Meet).
 * Used for narration, greetings, and responses.
 * Streaming: audio begins playing before the full text is synthesized.
 *
 * @param text - The text to speak
 * @param options - Speaking options
 */
export function speak(text: string, options?: {
  /** Wait for speech to complete before returning */
  waitForCompletion?: boolean;
  /** Interrupt any currently playing speech */
  interrupt?: boolean;
}): Promise<void>;

/**
 * Register a handler for classified user utterances.
 * The voice agent continuously listens, transcribes, classifies,
 * and emits events.
 *
 * @param handler - Called for each classified utterance
 */
export function onUtterance(handler: (utterance: UtteranceEvent) => void): void;

/**
 * Get the accumulated transcript and feedback summary.
 */
export function getTranscript(): DemoTranscript;

/**
 * Ask the user for a final verdict and capture their response.
 * Speaks the summary, asks "satisfied or changes?", classifies the answer.
 *
 * @returns The user's decision with structured feedback
 */
export function captureVerdict(): Promise<DemoTranscript>;

/**
 * Stop the voice agent. Disconnects STT/TTS WebSockets,
 * stops listening.
 */
export function stop(): Promise<void>;

/**
 * Get current agent state.
 */
export function getState(): VoiceAgentState;
```

**Dependencies:** `deepgram` SDK (WebSocket streaming), `elevenlabs` SDK (WebSocket streaming), `@anthropic-ai/sdk` (streaming messages), `demo/audio.ts`

**LLM System Prompt Structure:**

```
You are a product demo presenter inside a Google Meet call. You are walking
the user through a newly built feature.

## Your Context
- Implementation spec: {spec content}
- Current walkthrough step: {step N of M}
- Current browser URL: {url}
- Visible page elements: {accessibility tree snapshot}
- Feedback accumulated so far: {feedback buffer}

## Your Capabilities
You can: narrate what's on screen, answer questions about the feature,
drive the browser (navigate, click, type, scroll), and capture feedback.

## Classification Rules
When the user speaks, classify their utterance as:
- NAVIGATION: they want you to interact with the product
- QUESTION: they want information
- FEEDBACK: they're giving an opinion (positive or negative)
- CONTROL: they want to advance, skip, or end the walkthrough
- APPROVAL/REJECTION: they're giving a final verdict

## Response Style
- Keep responses concise (1-3 sentences)
- Narrate what you're doing: "Clicking the Settings button now..."
- Confirm before destructive navigation: "You want me to submit this form?"
- Acknowledge feedback: "Noted — you expected the toggle to animate."
```

---

### 2.5 Module: `demo/walkthrough.ts` (NEW)

**Responsibility:** Generate walkthrough plans from the implementation spec. Execute walkthrough steps by driving the product browser and coordinating with the voice agent.

**Public Interface:**

```typescript
import type { Page } from "playwright-core";
import type { UtteranceEvent } from "./voice-agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkthroughStep {
  id: string;                  // e.g., "FR-1"
  title: string;               // e.g., "Dashboard Overview"
  url: string;                 // e.g., "/dashboard"
  actions: WalkthroughAction[];
  narration: string;           // What the voice agent says during this step
  expectedState: string;       // Description of expected visual state
  completed: boolean;
  skipped: boolean;
}

export type WalkthroughAction =
  | { type: "navigate"; target: string }
  | { type: "click"; selector: string; description?: string }
  | { type: "type"; selector: string; value: string; description?: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "wait"; selector: string; timeout?: number }
  | { type: "screenshot"; name: string };

export interface WalkthroughPlan {
  specName: string;
  steps: WalkthroughStep[];
  generatedAt: string;
  totalSteps: number;
}

export interface WalkthroughState {
  status: "idle" | "running" | "paused" | "interrupted" | "complete";
  currentStepIndex: number;
  plan: WalkthroughPlan | null;
  interruptedBy: UtteranceEvent | null;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Generate a walkthrough plan from an implementation spec.
 * Reads the spec, identifies FRs, and produces a step-by-step
 * navigation plan with narration scripts.
 *
 * This is called during demo_setup (before the user joins).
 * The plan is generated by Claude reading the EIS.
 *
 * @param specDir - Path to the active spec directory
 * @param llmApiKey - Anthropic API key for plan generation
 * @returns WalkthroughPlan saved to specDir/.demo/walkthrough.json
 */
export function generatePlan(
  specDir: string,
  llmApiKey: string,
): Promise<WalkthroughPlan>;

/**
 * Execute the walkthrough plan step by step.
 *
 * For each step:
 * 1. voice-agent.speak(step.narration)
 * 2. Execute step.actions on the product page
 * 3. Take a screenshot for evidence
 * 4. Wait for user response (5s timeout)
 * 5. If no interruption, advance to next step
 *
 * If the user interrupts (navigation command, question, etc.),
 * the walkthrough pauses, the handler processes the interruption,
 * and execution resumes where it left off.
 *
 * @param plan - The walkthrough plan to execute
 * @param productPage - Playwright page handle for the product
 * @param onStepComplete - Called after each step completes
 */
export function execute(
  plan: WalkthroughPlan,
  productPage: Page,
  onStepComplete?: (step: WalkthroughStep, index: number) => void,
): Promise<void>;

/**
 * Pause the walkthrough (e.g., user is asking a question).
 */
export function pause(): void;

/**
 * Resume the walkthrough from where it was paused.
 */
export function resume(): void;

/**
 * Skip to a specific step by index or FR ID.
 */
export function skipTo(target: number | string): void;

/**
 * Handle an ad-hoc navigation request from the user.
 * Pauses the walkthrough, executes the navigation command,
 * and offers to resume.
 *
 * @param command - Parsed navigation command from voice-agent
 * @param productPage - Playwright page handle
 */
export function handleAdHocNavigation(
  command: UtteranceEvent["navigationCommand"],
  productPage: Page,
): Promise<void>;

/**
 * Get current walkthrough state.
 */
export function getState(): WalkthroughState;

/**
 * Load an existing plan from disk.
 */
export function loadPlan(planPath: string): WalkthroughPlan;
```

**Dependencies:** `playwright-core` (Page), `@anthropic-ai/sdk` (plan generation), `demo/voice-agent.ts` (narration)

---

### 2.6 Plugin Hook Scripts (CHANGES)

Side effects are dispatched via Claude Code plugin hooks registered in `hooks/hooks.json`. The `Stop` hook runs `scripts/validate-state.sh` which detects state transitions and executes side effects. The `PostToolUse` hook runs `scripts/detect-artifact.sh` for artifact detection.

**New Side Effect Handlers (in scripts or via TypeScript helper called from hooks):**

```typescript
// Inside executeSideEffects() — called from hook scripts:

case "CREATE_DEMO": {
  log("Creating demo session...");
  const demoDir = join(effect.specDir, ".demo");
  mkdirSync(demoDir, { recursive: true });

  try {
    // 1. Create Meet space
    await meetApi.initialize();
    const space = await meetApi.createSpace();
    writeFileSync(
      join(demoDir, "meet.json"),
      JSON.stringify(space, null, 2),
    );
    log(`Meet created: ${space.meetingUri}`);

    // 2. Generate walkthrough plan
    const plan = await walkthrough.generatePlan(
      effect.specDir,
      process.env.ANTHROPIC_API_KEY!,
    );
    log(`Walkthrough plan: ${plan.totalSteps} steps`);

    // 3. Initialize audio routing
    const audioRoutes = await audio.initialize();
    log(`Audio routing initialized (${await audio.detectPlatform()})`);

    // 4. Launch Meet bot
    const productPort = parseInt(process.env.DEV_SERVER_PORT || "3000", 10);
    const botState = await bot.launch({
      meetUrl: space.meetingUri,
      productUrl: `http://localhost:${productPort}`,
      botName: "Operant Demo",
      audioInputDevice: audioRoutes.chromeInputDeviceId,
      audioOutputDevice: audioRoutes.chromeOutputDeviceId,
    });
    log(`Meet bot launched: ${botState.status}`);

    // 5. Initialize voice agent
    await voiceAgent.initialize({
      audioRoutes,
      productPage: bot.getProductPage()!,
      walkthroughPlanPath: join(demoDir, "walkthrough.json"),
      implementationSpecPath: join(effect.specDir, "implementation-spec.md"),
      specDir: effect.specDir,
      stt: {
        provider: "deepgram",
        apiKey: process.env.DEEPGRAM_API_KEY!,
      },
      tts: {
        provider: "elevenlabs",
        apiKey: process.env.ELEVENLABS_API_KEY!,
      },
      llm: {
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
    });

    // Store demo state for other handlers
    demoMeetSpace = space;
    demoActive = true;

    // Transition to demo_calling
    await runTransition("DEMO_READY", {
      specDir: effect.specDir,
      meetUrl: space.meetingUri,
      meetCode: space.meetingCode,
    });
  } catch (err) {
    log(`ERROR: Demo setup failed: ${(err as Error).message}`);
    // Graceful fallback (NFC-4)
    await runTransition("DEMO_FAILED", {
      reason: (err as Error).message,
    });
  }
  break;
}

case "TRIGGER_DEMO_INVITE_CALL": {
  const wl = loadWhitelist();
  const toNumber = wl.default_blocker_target;
  if (!toNumber) {
    log("WARNING: No phone number for demo invite call");
    break;
  }
  const dynVars = buildDynamicVars("demo_invite", {
    meet_url: effect.meetUrl,
    meet_code: effect.meetCode,
    spec_name: activeSpecName(),
    feature_summary: `The ${activeSpecName()} feature has been built and verified.`,
  });

  if (process.env.SECONDAXIS_MOCK === "1") {
    log(`[MOCK] Demo invite call: join ${effect.meetUrl}`);
  } else {
    const agentId = getAgentId();
    const fromNumber = getPhoneNumber();
    await makeOutboundCall(fromNumber, toNumber, agentId, {
      spec_name: activeSpecName(),
      meet_code: effect.meetCode,
    }, dynVars);
    log(`Demo invite call triggered: ${effect.meetUrl}`);
  }
  break;
}

case "START_WALKTHROUGH": {
  const plan = walkthrough.loadPlan(
    join(effect.specDir, ".demo", "walkthrough.json"),
  );
  const productPage = bot.getProductPage()!;

  // Greet the user
  await voiceAgent.speak(
    `Welcome! I'll walk you through the ${activeSpecName()} feature. ` +
    `There are ${plan.totalSteps} things to show you. ` +
    `Feel free to interrupt me anytime — say "click" something, ` +
    `ask a question, or say "next" to skip ahead. Let's start.`,
    { waitForCompletion: true },
  );

  // Wire up utterance handler
  voiceAgent.onUtterance(async (utterance) => {
    switch (utterance.type) {
      case "navigation":
        walkthrough.pause();
        await walkthrough.handleAdHocNavigation(
          utterance.navigationCommand!,
          productPage,
        );
        await voiceAgent.speak("Done. Want me to continue the walkthrough?");
        // Resume on next "control" utterance
        break;
      case "question":
        walkthrough.pause();
        // LLM answers the question (handled internally by voice-agent)
        break;
      case "control":
        if (utterance.text.match(/next|skip|continue|resume/i)) {
          walkthrough.resume();
        } else if (utterance.text.match(/end|stop|done|that's enough/i)) {
          walkthrough.pause();
          await runTransition("WALKTHROUGH_COMPLETE", {
            specDir: activeSpecDir || "",
          });
        }
        break;
      case "approval":
      case "rejection":
        // Accumulate — final verdict captured in demo_feedback
        break;
    }
  });

  // Execute walkthrough
  await walkthrough.execute(plan, productPage, (step, idx) => {
    log(`Walkthrough step ${idx + 1}/${plan.totalSteps}: ${step.id} ${step.title}`);
  });

  // Walkthrough completed naturally
  await runTransition("WALKTHROUGH_COMPLETE", {
    specDir: activeSpecDir || "",
  });
  break;
}

case "CAPTURE_FEEDBACK": {
  const transcript = await voiceAgent.captureVerdict();

  // Write feedback to .demo/
  const demoDir = join(activeSpecDir!, ".demo");
  writeFileSync(
    join(demoDir, "feedback.json"),
    JSON.stringify(transcript, null, 2),
  );

  // Write trigger file for pipeline processing
  const triggerFile = `${Date.now()}-demo-${activeSpecName()}.json`;
  const triggerPath = join(dataDir, "pending", triggerFile);
  writeFileSync(triggerPath, JSON.stringify({
    call_id: `demo-${Date.now()}`,
    caller_name: "Demo Session",
    source: "meet-demo",
    spec: {
      decision: transcript.decision,
      pain_points: transcript.painPoints,
      navigation_requests: transcript.navigationRequests,
      positive_feedback: transcript.positives,
      raw_transcript: transcript.summary,
    },
    created_at: new Date().toISOString(),
  }, null, 2));

  if (transcript.decision === "approved") {
    await runTransition("DEMO_APPROVED", { specDir: activeSpecDir! });
  } else {
    await runTransition("DEMO_REJECTED", {
      specDir: activeSpecDir!,
      painPoints: transcript.painPoints.join("\n"),
    });
  }
  break;
}

case "WRITE_DEMO_REVISION": {
  const revisionsDir = join(effect.specDir, "revisions");
  mkdirSync(revisionsDir, { recursive: true });
  const existingRevisions = readdirSync(revisionsDir).filter(f => f.endsWith(".md"));
  const revNum = String(existingRevisions.length + 1).padStart(3, "0");
  const revPath = join(revisionsDir, `${revNum}-demo-feedback.md`);

  const revContent = [
    `# Revision: Demo Feedback`,
    ``,
    `**ID:** REV-${revNum}`,
    `**Source:** meet-demo`,
    `**Created:** ${new Date().toISOString()}`,
    `**Spec:** ${basename(effect.specDir)}`,
    ``,
    `---`,
    ``,
    `## What Failed`,
    ``,
    `User identified issues during live demo walkthrough:`,
    ``,
    ...effect.painPoints.map((p: string) => `- ${p}`),
    ``,
    `## Expected Behavior`,
    ``,
    `As described in implementation spec — see specific FR references above.`,
    ``,
    `## Observed Behavior`,
    ``,
    `User saw the product live and identified discrepancies.`,
    ``,
    `## Evidence`,
    ``,
    `Demo screenshots saved to spec/${basename(effect.specDir)}/.demo/screenshots/`,
    `Full demo transcript saved to spec/${basename(effect.specDir)}/.demo/feedback.json`,
    ``,
    `## Fix Guidance`,
    ``,
    `Address each pain point listed above. Re-run audit after fixes.`,
    ``,
  ].join("\n");

  writeFileSync(revPath, revContent);
  log(`Demo revision written: ${revPath}`);
  break;
}

case "TEARDOWN_DEMO": {
  try {
    await voiceAgent.stop();
    await bot.leave();
    await audio.teardown();
    if (demoMeetSpace) {
      await meetApi.endSpace(demoMeetSpace.name).catch(() => {});
    }
    demoActive = false;
    demoMeetSpace = null;
    log("Demo teardown complete");
  } catch (err) {
    log(`WARNING: Demo teardown error: ${(err as Error).message}`);
  }
  break;
}
```

**New Plugin-Scoped State:**

```typescript
// Add to module-level state:
let demoMeetSpace: MeetSpace | null = null;
let demoActive: boolean = false;
```

**Updated skill loading (UserPromptSubmit hook / inject-context.sh):**

```typescript
const skillMap: Record<Phase, string[]> = {
  idle: [],
  triage: [],
  sdlc: ["./skills/sdlc-skill/"],
  dev: ["./skills/development-methodology/"],
  audit: ["./skills/audit-methodology/"],
  demo: [],           // No skill needed — demo is infrastructure, not agent work
  confirmation: [],
};
```

**Updated SessionEnd hook (scripts/cleanup.sh):**

```bash
#!/bin/bash
# Tear down demo if active
if [ -f "$OPERANT_PI_DATA_DIR/demo-active" ]; then
  # TypeScript helper handles demo teardown
  npx tsx "${CLAUDE_PLUGIN_ROOT}/src/demo/teardown.ts"
fi
# Existing pipeline cleanup
bash "${CLAUDE_PLUGIN_ROOT}/scripts/stop-pipeline.sh"
```

---

### 2.7 Module: `retell.ts` (CHANGES)

**New call mode:**

```typescript
export type CallMode = "requirements" | "blocker" | "review" | "confirmation" | "demo_invite";

// In buildDynamicVars():
case "demo_invite":
  return {
    call_mode: "demo_invite",
    meet_url: context.meet_url,
    meet_code: context.meet_code,
    spec_name: context.spec_name,
    feature_summary: context.feature_summary,
  };
```

---

### 2.8 Module: `prompts/voice-agent.md` (CHANGES)

**New section added to the Retell voice agent prompt:**

```markdown
## DEMO INVITE (when {{call_mode}} = "demo_invite")

You are calling to invite the user to a live product demo on Google Meet.

**Feature:** {{feature_summary}}
**Meet link:** {{meet_url}}
**Meet code:** {{meet_code}}

### Your approach:
1. Greet: "Hey, the {{spec_name}} feature has been built and passed verification."
2. Offer demo: "I've set up a live demo on Google Meet where I'll walk you through
   everything I built. Would you like to join?"
3. If YES:
   - Read the Meet code clearly: "Join at meet.google.com slash {{meet_code}}.
     That's [spell out each segment]. I'll be sharing my screen showing the product."
   - "Take your time joining — I'll wait for you in the Meet."
   - End call.
4. If NO / "just confirm":
   - "No problem, I'll skip the demo and confirm on the phone instead."
   - End call.
5. If they ask for a link:
   - "I can read the code again: meet.google.com slash {{meet_code}}.
     Unfortunately I can't send links via text right now, but the code should be easy
     to type in."

### Structured output:
```json
{
  "call_mode": "demo_invite",
  "decision": "join" | "skip",
  "meet_code": "{{meet_code}}"
}
```
```

---

## 3. Persistence

### 3.1 Demo State Files

```
spec/<feature-name>/
  .demo/                         # Created during demo_setup
    meet.json                   # Meet space metadata
    walkthrough.json            # Generated walkthrough plan
    feedback.json               # Captured feedback (after demo)
    screenshots/                # Screenshots taken during walkthrough
      FR-1-dashboard.png
      FR-2-settings.png
      ...
```

### 3.2 File Formats

**meet.json:**
```json
{
  "name": "spaces/abc123",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "meetingCode": "abc-defg-hij",
  "config": {
    "accessType": "OPEN",
    "entryPointAccess": "ALL"
  },
  "createdAt": "ISO8601"
}
```

**walkthrough.json:** (See FR-6.2 in Intent doc for full schema)

**feedback.json:**
```json
{
  "utterances": [
    {
      "type": "feedback",
      "text": "The toggle doesn't animate",
      "confidence": 0.95,
      "timestamp": "ISO8601",
      "feedbackItem": {
        "sentiment": "negative",
        "relatedFR": "FR-3",
        "detail": "Toggle transition has no animation"
      }
    }
  ],
  "summary": "User approved overall but noted FR-3 toggle lacks animation.",
  "decision": "approved",
  "positives": ["Liked the dashboard layout", "Settings page was clear"],
  "painPoints": ["FR-3 toggle lacks animation"],
  "navigationRequests": ["Asked to see error state for email input"]
}
```

---

## 4. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_MEET_CREDENTIALS` | Yes (for demo) | Path to Google OAuth2 credentials JSON |
| `DEEPGRAM_API_KEY` | Yes (for demo) | Deepgram API key for streaming STT |
| `ELEVENLABS_API_KEY` | Yes (for demo) | ElevenLabs API key for streaming TTS |
| `ANTHROPIC_API_KEY` | Yes (existing) | Already used by Claude Code — also used for walkthrough plan generation and voice LLM |
| `DEV_SERVER_PORT` | No (default: 3000) | Port where the product dev server runs |
| `DEMO_GRACE_PERIOD_MS` | No (default: 15000) | Time to wait after demo_invite call before starting walkthrough |

---

## 5. Implementation Sequencing

| Step | Module | Deliverable | Dependencies | Risk |
|------|--------|-------------|--------------|------|
| 1 | `state-machine.ts` | Add demo states, transitions, events, side effects. Unit tests. | None | Low |
| 2 | `demo/meet.ts` | Google Meet API client. Create space, get URL. Integration test with real API. | Google Cloud project with Meet API enabled | Medium |
| 3 | `demo/audio.ts` | Virtual audio routing. PulseAudio (Linux) + BlackHole (macOS). Manual test: play audio through virtual device. | Platform-specific audio drivers | High |
| 4 | `demo/bot.ts` | Chromium launch + Meet join + tab sharing. Manual test: bot joins a Meet and shares a tab. | Steps 2, 3 | High |
| 5 | `demo/voice-agent.ts` | STT→LLM→TTS pipeline. Unit test with mock audio. Integration test with real APIs. | Step 3 (audio routes) | High |
| 6 | `demo/walkthrough.ts` | Plan generation from EIS. Plan execution with browser control. Unit test with mock page. | None (parallel with steps 2-5) |  Low |
| 7 | Plugin hooks + scripts | Wire demo side effects in hook scripts. Integration test end-to-end with mock Meet. | Steps 1-6 | Medium |
| 8 | `retell.ts` + `voice-agent.md` | Add `demo_invite` call mode and prompt section. | None (parallel) | Low |
| 9 | End-to-end test | Full pipeline: audit pass → demo setup → call → join → walkthrough → feedback → confirmation/revision | Steps 1-8 | High |

**Critical path:** Steps 3 (audio routing) and 4 (Meet bot) are the highest-risk items. These should be prototyped first in isolation before integrating.

---

## 6. Traceability Matrix

| Requirement | HLD Section | ADR | EIS Section | Test Category |
|-------------|-------------|-----|-------------|---------------|
| **FR-1.1** Demo phase in FSM | 4. All flows | — | 1.1-1.5 | fsm_demo_states |
| **FR-1.2** Demo FSM states | 4. All flows | — | 1.1 States table | fsm_demo_states |
| **FR-1.3** Demo transitions | 4. All flows | — | 1.2 Transitions table | fsm_demo_transitions |
| **FR-1.4** Demo skip path | 4. Flow B | ADR-007 | 1.2 T28, T29 | demo_skip |
| **FR-2.1** Meet creation | 4. Flow A | ADR-005 | 2.1 meet.ts | meet_creation |
| **FR-2.2** Meet join URL | 4. Flow A | ADR-005 | 2.1 MeetSpace type | meet_url |
| **FR-2.3** Meet metadata storage | 4. Flow A | — | 3.1 .demo/meet.json | meet_persistence |
| **FR-2.5** Meet auth | 4. Flow A | — | 2.1 initialize(), 4. Env vars | meet_auth |
| **FR-3.1** Chromium bot launch | 3. Meet Bot | ADR-001 | 2.2 bot.ts launch() | bot_launch |
| **FR-3.2** Chrome flags | 3. Meet Bot | ADR-003 | 2.2 CHROME_FLAGS | bot_flags |
| **FR-3.3** Bot Google auth | 3. Meet Bot | — | 2.2 Meet Join Sequence | bot_auth |
| **FR-3.4** Tab sharing | 3. Meet Bot | ADR-002 | 2.2 Meet Join Sequence | bot_sharing |
| **FR-3.5** Virtual display | 3. Meet Bot | ADR-001 | 2.2 BotConfig.displayNumber | bot_display |
| **FR-4.1** Bidirectional audio | 3. Voice Pipeline | ADR-003 | 2.3 audio.ts | audio_routing |
| **FR-4.2** Voice AI pipeline | 3. Voice Pipeline | ADR-004 | 2.4 voice-agent.ts | voice_pipeline |
| **FR-4.3** Real-time latency | 3. Voice Pipeline | ADR-004 | NFC-1, 2.4 config | voice_latency |
| **FR-4.4** Voice agent context | 3. Voice Pipeline | — | 2.4 LLM System Prompt | voice_context |
| **FR-5.1** Product at localhost | 3. Product Browser | ADR-002 | 2.2 BotConfig.productUrl | product_browser |
| **FR-5.2** Playwright MCP control | 3. Product Browser | — | 2.5 walkthrough.ts | browser_control |
| **FR-5.4** Walkthrough plan | 3. Walkthrough Engine | — | 2.5 WalkthroughPlan type | walkthrough_plan |
| **FR-5.5** Ad-hoc navigation | 4. Flow C | — | 2.5 handleAdHocNavigation | adhoc_nav |
| **FR-6** Plan generation | 3. Walkthrough Engine | — | 2.5 generatePlan() | plan_generation |
| **FR-7.1** Utterance classification | 4. Flow C | — | 2.4 UtteranceType | utterance_classify |
| **FR-7.2** Verdict capture | 4. Flow D | — | 2.4 captureVerdict() | verdict_capture |
| **FR-7.3** Feedback trigger file | 4. Flow D | — | 2.6 CAPTURE_FEEDBACK | feedback_trigger |
| **FR-7.4** Demo revision | 4. Flow D | — | 2.6 WRITE_DEMO_REVISION | demo_revision |
| **FR-8.1** demo_invite call | 4. Flow B | — | 2.7 retell.ts changes | demo_invite_call |
| **FR-8.4** demo_invite vars | 4. Flow B | — | 2.7, 2.8 | demo_invite_vars |
| **FR-9** Module structure | 3. Module Dependency | — | 2.1-2.5 | module_structure |
| **NFC-1** Voice latency < 2s | 5. Tech Choices | ADR-004 | 2.4 streaming config | latency_test |
| **NFC-4** Graceful fallback | 8. Risks | ADR-007 | 1.2 T28, T29 (DEMO_SKIPPED/FAILED) | fallback_test |
| **NFC-8** FSM purity | 4. All flows | — | 1.1-1.5 (side effects returned) | fsm_purity |
