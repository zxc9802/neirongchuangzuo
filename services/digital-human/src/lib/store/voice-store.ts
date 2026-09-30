import { logServerError } from "../server/safe-log";
import fs from "fs";
import path from "path";
import { CosService } from "../cos";

export interface VoiceItem {
  id: string;
  userId?: string;
  name: string;
  audioUrl: string;
  audioPath?: string;
  description?: string;
  createdAt: number;
  isDefault?: boolean;
  canManage?: boolean;
}

const STATE_DIR = path.join(process.cwd(), ".runtime", "state");
const VOICES_FILE_PATH = path.join(STATE_DIR, "voices.json");
const BACKUP_VOICES_PATH = path.join(STATE_DIR, "voices.backup.json");
const LEGACY_VOICES_PATH = path.join(process.cwd(), ".voices.json");
const LEGACY_ROOT_BACKUP_VOICES_PATH = path.join(process.cwd(), ".voices.backup.json");
const LEGACY_BACKUP_VOICES_PATH = path.join(process.cwd(), "public", "jobs", ".backup", ".voices.json");
const COS_VOICES_KEY = "_system/voices.json";

const DEFAULT_VOICES: VoiceItem[] = [
  {
    id: "default_speaker_1",
    name: "默认推荐音色 (深沉口播)",
    audioUrl: process.env.INDEXTTS_SPEAKER_AUDIO_URL || "",
    description: "稳重大气，适合企业宣讲、商业洞察与深度口播",
    createdAt: 1787700000000,
    isDefault: true,
  },
];

let memoryVoices: VoiceItem[] = [];
let hasLoadedFromCloud = false;

function reloadFromDisk() {
  try {
    let raw = "";
    let migrateLegacy = false;
    if (fs.existsSync(VOICES_FILE_PATH)) {
      raw = fs.readFileSync(VOICES_FILE_PATH, "utf-8");
    } else if (fs.existsSync(BACKUP_VOICES_PATH)) {
      raw = fs.readFileSync(BACKUP_VOICES_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_VOICES_PATH)) {
      raw = fs.readFileSync(LEGACY_VOICES_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_ROOT_BACKUP_VOICES_PATH)) {
      raw = fs.readFileSync(LEGACY_ROOT_BACKUP_VOICES_PATH, "utf-8");
      migrateLegacy = true;
    } else if (fs.existsSync(LEGACY_BACKUP_VOICES_PATH)) {
      raw = fs.readFileSync(LEGACY_BACKUP_VOICES_PATH, "utf-8");
      migrateLegacy = true;
    }

    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        memoryVoices = parsed;
      }
      if (migrateLegacy) {
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true });
          fs.writeFileSync(VOICES_FILE_PATH, raw, "utf-8");
          fs.writeFileSync(BACKUP_VOICES_PATH, raw, "utf-8");
        } catch {}
      }
    } else {
      memoryVoices = [...DEFAULT_VOICES];
    }
  } catch (e) {
    memoryVoices = [...DEFAULT_VOICES];
  }
}

function persistStore() {
  try {
    const content = JSON.stringify(memoryVoices, null, 2);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(VOICES_FILE_PATH, content, "utf-8");

    // Mirror to persistent mounted volume
    try {
      fs.writeFileSync(BACKUP_VOICES_PATH, content, "utf-8");
    } catch {}

    // Mirror to cloud object storage
    if (CosService.isConfigured()) {
      CosService.saveJsonToCos(COS_VOICES_KEY, memoryVoices).catch((err) => {
        logServerError("voices.sync_failed", err, "warn");
      });
    }
  } catch (e) {
    logServerError("voices.persist_failed", e);
  }
}

reloadFromDisk();

export const VoiceStore = {
  async getAllAsync(): Promise<VoiceItem[]> {
    reloadFromDisk();

    if ((memoryVoices.length <= 1 || !hasLoadedFromCloud) && CosService.isConfigured()) {
      try {
        const cloudVoices = await CosService.getJsonFromCos<VoiceItem[]>(COS_VOICES_KEY);
        if (cloudVoices && Array.isArray(cloudVoices) && cloudVoices.length > 0) {
          memoryVoices = cloudVoices;
          hasLoadedFromCloud = true;
          persistStore();
        }
      } catch (err: any) {
        logServerError("voices.load_failed", err, "warn");
      }
    }

    return [...memoryVoices];
  },

  getAll(): VoiceItem[] {
    reloadFromDisk();
    return [...memoryVoices];
  },

  get(id: string): VoiceItem | undefined {
    reloadFromDisk();
    return memoryVoices.find((v) => v.id === id);
  },

  getDefault(): VoiceItem {
    reloadFromDisk();
    return memoryVoices.find((v) => v.isDefault) || memoryVoices[0] || DEFAULT_VOICES[0];
  },

  create(voice: Omit<VoiceItem, "id" | "createdAt">): VoiceItem {
    reloadFromDisk();
    const id = "voice_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
    const newVoice: VoiceItem = {
      ...voice,
      id,
      createdAt: Date.now(),
    };

    memoryVoices.unshift(newVoice);
    persistStore();
    return newVoice;
  },

  delete(id: string): boolean {
    reloadFromDisk();
    const target = memoryVoices.find((v) => v.id === id);
    if (target && target.isDefault) {
      throw new Error("无法删除系统预设的默认音色");
    }

    const index = memoryVoices.findIndex((v) => v.id === id);
    if (index !== -1) {
      memoryVoices.splice(index, 1);
      persistStore();
      return true;
    }
    return false;
  },
};
