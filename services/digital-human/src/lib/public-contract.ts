export type PublicEngine = "a" | "b" | "c";

export type PublicTaskStep =
  | "idle"
  | "voice"
  | "prepare"
  | "check"
  | "render"
  | "finalize"
  | "done"
  | "error";

export interface PublicLogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface PublicTaskBilling {
  source?: "workspace" | "main-app" | "internal";
  exempt?: boolean;
  isExternalUser: boolean;
  estimatedDuration?: number;
  estimatedPoints?: number;
  reservedPoints?: number;
  actualDuration?: number;
  chargedPoints?: number;
  costCny?: number;
  status:
    | "not_applicable"
    | "reserving"
    | "reserved"
    | "provider_committed"
    | "settle_pending"
    | "settled"
    | "released"
    | "insufficient_balance";
}

export interface PublicTaskItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  expiresAt?: number;
  outputExpired: boolean;
  status: "pending" | "processing" | "completed" | "failed";
  step: PublicTaskStep;
  failedStep?: PublicTaskStep;
  progress: number;
  logs: PublicLogEntry[];
  billing?: PublicTaskBilling;
  inputs: {
    outputType?: "video" | "audio";
    avatarId?: string;
    videoName: string;
    scriptText: string;
    toneProfile: "low" | "high";
    videoFit: "smart" | "preserve";
    emotionIntensity: number;
    speakerVoiceId?: string;
    engine: PublicEngine;
  };
  results: {
    downloadUrl?: string;
    originalVideoUrl?: string;
    finalVideoUrl?: string;
    exactAudioUrl?: string;
    audioFormat?: "wav" | "mp3";
    evidenceJsonUrl?: string;
    chargedPoints?: number;
    costCny?: number;
    billingDuration?: number;
    videoDuration?: number;
    audioDuration?: number;
    resolution?: string;
    fps?: number;
    sha256Video?: string;
    sha256Audio?: string;
  };
  recoverable: boolean;
  error?: string;
}

export interface PublicVoiceItem {
  id: string;
  name: string;
  audioUrl: string;
  description?: string;
  createdAt: number;
  isDefault?: boolean;
  canManage?: boolean;
}

export interface PublicAvatarItem {
  id: string;
  name: string;
  videoUrl: string;
  coverUrl?: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  fileSize: number;
  createdAt: number;
  storedRemotely?: boolean;
  canManage?: boolean;
}

export interface PublicVideoSelection {
  avatarId: string;
  name: string;
  previewUrl: string;
  probe: {
    width?: number;
    height?: number;
    durationSeconds?: number;
    fps?: number;
    hasAudio?: boolean;
  } | null;
}
