import { readFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

export interface RepoPipelineConfig {
  preProductionBranches: string[];
  productionBranch: string;
}

type PipelineConfigFile = Record<string, RepoPipelineConfig>;

let cachedConfig: PipelineConfigFile | null = null;

function loadPipelineConfig(): PipelineConfigFile {
  if (cachedConfig) return cachedConfig;

  try {
    const raw = readFileSync(new URL("../../pipeline.json", import.meta.url), "utf-8");
    const parsed = JSON.parse(raw) as PipelineConfigFile;
    cachedConfig = parsed;
  } catch (err) {
    logger.warn({ err }, "pipeline.json not found or invalid; pipeline-aware dedupe disabled");
    cachedConfig = {};
  }

  return cachedConfig;
}

export function pipelineConfigForRepo(repo: string): RepoPipelineConfig | null {
  const config = loadPipelineConfig()[repo];
  if (!config?.productionBranch || !Array.isArray(config.preProductionBranches)) {
    return null;
  }

  return config;
}
